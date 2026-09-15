import prompts from "prompts";
import { MyHoursClient } from "./client.js";
import { MyHoursProject, MyHoursProjectTask } from "./structures.js";
import { BranchAssignment, IStorage, getStorage, updateStorage } from "./storage.js";

const SKIP = "skip" as const;

// Score how well `input`'s characters appear in order (not necessarily contiguous)
// within `title`; lower is a tighter match. `null` means no match at all.
function fuzzyScore(input: string, title: string): number|null {
    const normInput = input.toLowerCase();
    const normTitle = title.toLowerCase();
    let score = 0;
    let titleIndex = 0;
    for (const char of normInput) {
        const found = normTitle.indexOf(char, titleIndex);
        if (found === -1) {
            return null;
        }
        score += found - titleIndex;
        titleIndex = found + 1;
    }
    return score;
}

function fuzzySuggest(input: string, choices: prompts.Choice[]): Promise<prompts.Choice[]> {
    if (!input) {
        return Promise.resolve(choices);
    }
    const scored = choices
        .map(choice => ({ choice, score: fuzzyScore(input, choice.title) }))
        .filter((s): s is { choice: prompts.Choice; score: number } => s.score !== null)
        .sort((a, b) => a.score - b.score);
    return Promise.resolve(scored.map(s => s.choice));
}

interface CreateTaskMarker {
    createTaskName: string;
}

function isCreateTaskMarker(value: unknown): value is CreateTaskMarker {
    return typeof value === "object" && value !== null && "createTaskName" in value;
}

// Unlike Projects (a fixed, org-managed list), Will can create his own Tasks,
// so the Task picker offers a synthetic "create new" choice whenever the typed
// text doesn't exactly match an existing task.
async function taskSuggest(input: string, choices: prompts.Choice[]): Promise<prompts.Choice[]> {
    const filtered = await fuzzySuggest(input, choices);
    const trimmed = input.trim();
    if (!trimmed || choices.some(c => c.title.toLowerCase() === trimmed.toLowerCase())) {
        return filtered;
    }
    const createChoice: prompts.Choice = {
        title: `+ Create new task "${trimmed}"`,
        value: { createTaskName: trimmed },
    };
    return [createChoice, ...filtered];
}

let projectsCache: MyHoursProject[] | null = null;
const tasksCache = new Map<number, MyHoursProjectTask[]>();

async function getProjectsCached(client: MyHoursClient): Promise<MyHoursProject[]> {
    if (!projectsCache) {
        projectsCache = await client.getActiveProjects();
    }
    return projectsCache;
}

async function getTasksCached(client: MyHoursClient, projectId: number): Promise<MyHoursProjectTask[]> {
    let tasks = tasksCache.get(projectId);
    if (!tasks) {
        tasks = await client.getProjectTasks(projectId);
        tasksCache.set(projectId, tasks);
    }
    return tasks;
}

const HOLIDAY_PROJECT_NAME = "Holiday / Sickness / Public Holiday / Other Leave";
const HOLIDAY_TASK_NAME = "Holiday";

// Unlike branch work, holiday time always goes under the same fixed org project/task,
// so this is resolved by name rather than prompted for.
export async function getHolidayAssignment(client: MyHoursClient): Promise<BranchAssignment> {
    const projects = await getProjectsCached(client);
    const project = projects.find(p => p.name.toLowerCase() === HOLIDAY_PROJECT_NAME.toLowerCase());
    if (!project) {
        throw new Error(`Could not find a "${HOLIDAY_PROJECT_NAME}" project in your active MyHours projects.`);
    }
    const tasks = await getTasksCached(client, project.id);
    let task = tasks.find(t => t.name.toLowerCase() === HOLIDAY_TASK_NAME.toLowerCase());
    if (!task) {
        task = await client.createProjectTask(project.id, HOLIDAY_TASK_NAME);
        tasksCache.get(project.id)?.push(task);
    }
    return { projectId: project.id, projectName: project.name, taskId: task.id, taskName: task.name };
}

export function branchAssignmentKey(repoPath: string, branch: string): string {
    return `${repoPath}::${branch}`;
}

// Looks up a branch's assignment without prompting - used by commit-week, which
// must fail rather than ask, if summarise-week hasn't been run to completion yet.
export async function getCachedAssignment(repoPath: string, branch: string): Promise<BranchAssignment|'skip'|undefined> {
    const storage = await getStorage();
    return storage?.branchAssignments?.[branchAssignmentKey(repoPath, branch)];
}

function countBy<T>(values: T[], keyOf: (value: T) => number): Map<number, number> {
    const counts = new Map<number, number>();
    for (const value of values) {
        const key = keyOf(value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

// Sort choices so ones you've picked before (for any branch) float to the top,
// most-used first; never-used choices keep their original relative order.
function byUsage<T>(items: T[], usage: Map<number, number>, idOf: (item: T) => number): T[] {
    return [...items].sort((a, b) => (usage.get(idOf(b)) ?? 0) - (usage.get(idOf(a)) ?? 0));
}

function getPastAssignments(storage: IStorage|null): BranchAssignment[] {
    return Object.values(storage?.branchAssignments ?? {}).filter((a): a is BranchAssignment => a !== SKIP);
}

export async function getOrPromptAssignment(client: MyHoursClient, repoPath: string, repoName: string, branch: string, forcePrompt = false): Promise<BranchAssignment|typeof SKIP> {
    const key = branchAssignmentKey(repoPath, branch);
    const storage = await getStorage();
    const existing = storage?.branchAssignments?.[key];
    if (existing && !forcePrompt) {
        return existing;
    }

    const pastAssignments = getPastAssignments(storage);
    const projects = await getProjectsCached(client);
    const projectUsage = countBy(pastAssignments, a => a.projectId);
    const orderedProjects = byUsage(projects, projectUsage, p => p.id);
    const { project } = await prompts({
        type: "autocomplete",
        name: "project",
        message: `Project for ${repoName} (${branch})?`,
        suggest: fuzzySuggest,
        choices: [
            { title: "Skip / not billable", value: SKIP },
            ...orderedProjects.map(p => ({ title: p.clientName ? `${p.name} (${p.clientName})` : p.name, value: p })),
        ],
    });

    let result: BranchAssignment|typeof SKIP;
    if (!project || project === SKIP) {
        result = SKIP;
    } else {
        const tasks = await getTasksCached(client, project.id);
        const taskUsage = countBy(pastAssignments.filter(a => a.projectId === project.id), a => a.taskId);
        const orderedTasks = byUsage(tasks, taskUsage, t => t.id);
        const { task } = await prompts({
            type: "autocomplete",
            name: "task",
            message: `Task for ${project.name}? (type to create a new one)`,
            suggest: taskSuggest,
            choices: [
                { title: "Skip / not billable", value: SKIP },
                ...orderedTasks.map(t => ({ title: t.name, value: t })),
            ],
        });
        if (!task || task === SKIP) {
            result = SKIP;
        } else if (isCreateTaskMarker(task)) {
            const created = await client.createProjectTask(project.id, task.createTaskName);
            tasksCache.get(project.id)?.push(created);
            result = { projectId: project.id, projectName: project.name, taskId: created.id, taskName: created.name };
        } else {
            result = { projectId: project.id, projectName: project.name, taskId: task.id, taskName: task.name };
        }
    }

    await updateStorage({
        branchAssignments: { ...(storage?.branchAssignments ?? {}), [key]: result },
    });
    return result;
}
