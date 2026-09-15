#!/usr/bin/env node
import prompts from "prompts";
import { program as Program } from "commander";
import { homedir } from "os";
import path from "path";
import { MyHoursApiError, MyHoursClient } from "./client.js";
import { MyHoursTask } from "./structures.js";
import * as luxon from "luxon";
import { BranchAssignment, getStorage, IStorage, storeStorage, updateStorage } from "./storage.js";
import { buildWeekSummary, getWeekWindow } from "./summary.js";
import { getCachedAssignment, getHolidayAssignment, getOrPromptAssignment } from "./projects.js";
import { getHolidayDates } from "./calendar.js";

function formatHours(hours: number): string {
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

async function getClient(): Promise<MyHoursClient> {
    let storage: IStorage|null;
    try {
        storage = await getStorage();
    } catch (ex) {
        throw Error('Could not open storage for reading. ' + ex);
    }
    if (storage?.accessToken) {
        // Check existing config
        const client = new MyHoursClient(storage.accessToken);
        try {
            await client.getCurrentTasks();
            return client;
        } catch (ex) {
            if (ex instanceof MyHoursApiError && ex.statusCode === 401) {
                // Needs to reauthenticate
                storage = null;
                console.log("Token expired, please enter a new token");
            } else {
                throw ex;
            }
        }
    }
    // New config
    const {accessToken} = await prompts([{
        message: 'Provide a MyHours API key',
        type: 'password',
        name: 'accessToken',
    }]);
    const client = new MyHoursClient(accessToken);
    await client.getCurrentTasks();
    await storeStorage({accessToken});
    console.log("Stored new configuration");
    return client;
}

async function getIcalUrl(): Promise<string|null> {
    const storage = await getStorage();
    if (storage?.icalUrl !== undefined) {
        return storage.icalUrl;
    }
    const { icalUrl } = await prompts([{
        message: 'Google Calendar private iCal URL for holiday tracking? (leave blank to skip)',
        type: 'password',
        name: 'icalUrl',
    }]);
    const normalized: string|null = icalUrl ? icalUrl : null;
    await updateStorage({ icalUrl: normalized });
    return normalized;
}

async function getPrettyTaskList(client: MyHoursClient, dateToCheck: Date, standup: boolean) {
    const rawTasks = await client.getLogs(dateToCheck);
    const tasks = Object.values(rawTasks.reduce<Record<string, MyHoursTask[]>>((taskSet, task) => {
        if (!task.note) {
            return taskSet;
        }
        if (taskSet[task.note]) {
            taskSet[task.note].push(task);
        } else {
            taskSet[task.note] = [task];
        }
        return taskSet;
    }, {})).map(taskSet => {
        const orderedTimesStart = taskSet.flatMap(t => t.times.filter(t => t.startTime).map(time => Date.parse(time.startTime))).sort();
        const orderedTimesEnd = taskSet.flatMap(t => t.times.filter(t => t.endTime).map(time => Date.parse(time.endTime))).sort();
        if (!taskSet[0].note) {
            throw Error("task missing note. This shouldn't happen");
        }
        return {
            ids: taskSet.map(t => t.id),
            start: orderedTimesStart[0] ?? null,
            end: orderedTimesEnd[orderedTimesEnd.length-1] ?? null,
            duration: luxon.Duration.fromMillis(taskSet.reduce((prev, task) => task.duration + prev, 0) * 1000).shiftTo('hours', 'minutes').toHuman({ unitDisplay: "short", maximumSignificantDigits: 2 }),
            // Assuming task 0 is the same.
            note: taskSet[0].note.trim(),
            tags: taskSet[0].tags?.sort((t1,t2) => t1.id - t2.id),
        }
    }).sort((t1, t2) => t1.start - t2.start);

    if (tasks.length) {
        const isYesterday = (new Date().getDay()-dateToCheck.getDay() === 1);
        if (standup) {
            console.log(isYesterday ? "Yesterday:" : "Last week:")
        }
        tasks.forEach(taskSet => {
            if (standup) {
                const tag = taskSet.tags[0] ? `**${taskSet.tags[0].name}**: ` : "";
                console.log(`  - ${tag}${taskSet.note}`);
            } else {
                const start = taskSet.start ? luxon.DateTime.fromMillis(taskSet.start).toFormat('HH:mm') : "";
                const end = taskSet.end ? luxon.DateTime.fromMillis(taskSet.end).toFormat('HH:mm') : "";
                console.log(`📋 ${start} - ${end} ${taskSet.duration} ${taskSet.note} (${taskSet.tags.map(t => `#${t.name}`).join(',')})`);
            }
        });
        if (standup) {
            console.log("\nToday:\n  - Something")
        }
    } else {
        console.log("There are no tasks");
    }
}


async function main() {
    Program.name('my-hours');
    const client = await getClient();
    Program.command('start')
        .description('Track a new task')
        .option('-t, --tags <tag>', 'Comma seperated list of tags to apply')
        .option('-s, --startTime <time>', 'Comma seperated list of tags to apply')
        .argument('<note>', 'Task description').action(async (note: string, { tags, startTime }: Record<string, string>) => {
        const startDate = startTime ? luxon.DateTime.fromISO(startTime).toJSDate() : undefined;
        const tagsStr: undefined|string[] = tags?.split(',').map((s: string) => s.trim());
        const tagsDefs = tagsStr && await client.getOrCreateTags(tagsStr);
        const { id } = await client.addTimeLog(note, tagsDefs, startDate);
        console.log("Started new log: ", id);
    });
    Program.command('running', { isDefault: true }).description('Get running tasks').action(async () => {
        const tasks = (await client.getCurrentTasks()).filter(t => t.running);
        if (tasks.length) {
            tasks.forEach(task => {
                const startDate = new Date(task.times[0]?.startTime);
                const duration = luxon.Duration.fromMillis(Date.now() - startDate.getTime()).shiftTo('hours', 'minutes').toHuman({ unitDisplay: "short", maximumSignificantDigits: 1 })
                console.log(` 📋 ${duration} | ${task.id} - ${task.note}`);
            });
        } else {
            console.log("There are no running tasks");
        }
    });
    Program.command('previous').description('Get tasks from the previous day').option('-s, --standup').option('-d, --date <date>').action(async ({standup, date}) => {
        // Get last work day - TODO: Use calendar for this.
        let dateToCheck = new Date();
        if (!date) {
            if (dateToCheck.getUTCDay() === 0) { // sunday
                dateToCheck = new Date(dateToCheck.getTime() - 2*24*60*60*1000);
            } else if (dateToCheck.getUTCDay() === 1) { // monday
                dateToCheck = new Date(dateToCheck.getTime() - 3*24*60*60*1000);
            } else if (dateToCheck.getUTCDay() <= 6) { // previous day
                dateToCheck = new Date(dateToCheck.getTime() - 24*60*60*1000)
            }
        } else {
            dateToCheck = luxon.DateTime.fromFormat(date, 'dd-LL').toJSDate();
        }
        await getPrettyTaskList(client, dateToCheck, standup);
    });
    Program.command('today').description('Get tasks for today').option('-s, --standup').option('-d, --date <date>').action(async ({standup}) => {
        await getPrettyTaskList(client, new Date(), standup);
    });
    Program.command('stop').description('Stop a task.').argument('[taskId]', 'Task ID. If ommitted, will stop all running tasks.').action(async (taskId) => {
        let taskIds: number[];
        if (!taskId) {
            taskIds = (await client.getCurrentTasks()).filter(t => t.running).map(t => t.id);
        } else {
            taskIds = [parseInt(taskId)];
        }
        if (!taskIds.length) {
            console.log("There are no running tasks");
            return;
        }
        for (const taskId of taskIds) {
            const log = await client.stopTimeLog(taskId);
            const time = luxon.Duration.fromMillis(log.duration * 1000).shiftTo('hours', 'minutes').toHuman({ unitDisplay: "short", maximumSignificantDigits: 2 });
            console.log(`Stopped task ${log.note || log.id}. Recorded ${time}`);
        }
        console.log("Stopped running task(s)");
    });
    Program.command('summarise-week').description('Estimate hours worked this week from git activity across ~/git repos and assign a Project/Task')
        .option('--reassign', 'Ignore cached Project/Task assignments and prompt again for every branch touched this run')
        .option('-d, --date <date>', 'A date (yyyy-mm-dd) within the week to summarise, defaults to this week')
        .action(async ({ reassign, date }) => {
        const referenceDate = date ? luxon.DateTime.fromISO(date) : undefined;
        if (referenceDate && !referenceDate.isValid) {
            console.error(`Invalid --date "${date}", expected yyyy-mm-dd`);
            return;
        }
        const days = await buildWeekSummary({ rootDir: path.join(homedir(), 'git'), referenceDate });
        const { weekStart, weekEnd } = getWeekWindow(referenceDate);
        const icalUrl = await getIcalUrl();
        const holidayDates = icalUrl ? await getHolidayDates(icalUrl, weekStart, weekEnd) : new Set<string>();

        if (!days.length && !holidayDates.size) {
            console.log("No git activity found for that week.");
            return;
        }
        const holidayAssignment = holidayDates.size ? await getHolidayAssignment(client) : null;

        const allDates = [...new Set([...days.map(d => d.date), ...holidayDates])].sort();
        let weekTotal = 0;
        for (const dateStr of allDates) {
            console.log(`\n${luxon.DateTime.fromISO(dateStr).toFormat('cccc yyyy-LL-dd')}`);
            let dayTotal = 0;
            const day = days.find(d => d.date === dateStr);
            for (const entry of day?.entries ?? []) {
                const assignment = await getOrPromptAssignment(client, entry.repoPath, entry.repoName, entry.branch, reassign);
                if (assignment === 'skip') {
                    continue;
                }
                dayTotal += entry.hours;
                console.log(`  ${entry.repoName} (${entry.branch}) — ${assignment.projectName} / ${assignment.taskName}: ${formatHours(entry.hours)} [${entry.commitCount} commits, ${entry.firstTime}–${entry.lastTime}]`);
            }
            if (holidayAssignment && holidayDates.has(dateStr)) {
                dayTotal += 8;
                console.log(`  Holiday — ${holidayAssignment.projectName} / ${holidayAssignment.taskName}: 8h`);
            }
            weekTotal += dayTotal;
        }
        console.log(`\nTotal this week: ${formatHours(weekTotal)}`);
    });
    Program.command('commit-week').description('Push this week\'s estimated hours to MyHours. Requires summarise-week to have already assigned a Project/Task to every branch touched this week.')
        .option('-d, --date <date>', 'A date (yyyy-mm-dd) within the week to commit, defaults to this week')
        .option('-y, --yes', 'Skip the confirmation prompt before pushing')
        .action(async ({ date, yes }) => {
        const referenceDate = date ? luxon.DateTime.fromISO(date) : undefined;
        if (referenceDate && !referenceDate.isValid) {
            console.error(`Invalid --date "${date}", expected yyyy-mm-dd`);
            return;
        }
        const days = await buildWeekSummary({ rootDir: path.join(homedir(), 'git'), referenceDate });
        const { weekStart, weekEnd } = getWeekWindow(referenceDate);
        const storage = await getStorage();
        const icalUrl = storage?.icalUrl ?? null;
        const holidayDates = icalUrl ? await getHolidayDates(icalUrl, weekStart, weekEnd) : new Set<string>();

        if (!days.length && !holidayDates.size) {
            console.log("No git activity found for that week.");
            return;
        }

        // Fail fast rather than prompt - every branch must already have been
        // assigned (or explicitly skipped) via summarise-week.
        const unassigned = new Set<string>();
        const toLog: Array<{ key: string, date: string, detail: string, hours: number, assignment: BranchAssignment }> = [];
        for (const day of days) {
            for (const entry of day.entries) {
                const assignment = await getCachedAssignment(entry.repoPath, entry.branch);
                if (assignment === undefined) {
                    unassigned.add(`${entry.repoName} (${entry.branch})`);
                } else if (assignment !== 'skip') {
                    toLog.push({
                        key: `${day.date}|${entry.repoPath}|${entry.branch}`,
                        date: day.date,
                        detail: `${entry.repoName} (${entry.branch}) - ${entry.commitCount} commits`,
                        hours: entry.hours,
                        assignment,
                    });
                }
            }
        }
        if (unassigned.size) {
            console.error(`Cannot commit - run "summarise-week" first to assign a Project/Task to:\n  ${[...unassigned].join('\n  ')}`);
            return;
        }

        if (holidayDates.size) {
            const holidayAssignment = await getHolidayAssignment(client);
            for (const holidayDate of holidayDates) {
                toLog.push({ key: `${holidayDate}|holiday`, date: holidayDate, detail: 'Holiday', hours: 8, assignment: holidayAssignment });
            }
        }

        const alreadyCommitted = storage?.committedEntries ?? {};
        const pending = toLog.filter(entry => !alreadyCommitted[entry.key]);
        if (!pending.length) {
            console.log("Nothing new to commit - this week has already been pushed to MyHours.");
            return;
        }

        // Merge entries that land on the same day and the same Project/Task into
        // a single log entry, so e.g. two branches under the same project don't
        // create two separate rows in MyHours.
        const groups = new Map<string, { date: string, assignment: BranchAssignment, hours: number, details: string[], keys: string[] }>();
        for (const entry of pending) {
            const groupKey = `${entry.date}|${entry.assignment.projectId}|${entry.assignment.taskId}`;
            let group = groups.get(groupKey);
            if (!group) {
                group = { date: entry.date, assignment: entry.assignment, hours: 0, details: [], keys: [] };
                groups.set(groupKey, group);
            }
            group.hours += entry.hours;
            group.details.push(entry.detail);
            group.keys.push(entry.key);
        }
        const commits = [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));

        console.log(`About to push ${commits.length} time log(s) to MyHours:`);
        for (const commit of commits) {
            console.log(`  ${commit.date} ${commit.assignment.projectName} / ${commit.assignment.taskName}: ${formatHours(commit.hours)} — ${commit.details.join('; ')}`);
        }
        if (!yes) {
            const { confirmed } = await prompts([{ type: 'confirm', name: 'confirmed', message: 'Push these to MyHours?', initial: false }]);
            if (!confirmed) {
                console.log("Aborted, nothing was pushed.");
                return;
            }
        }

        let pushedCount = 0;
        for (const commit of commits) {
            await client.insertLog({
                projectId: commit.assignment.projectId,
                taskId: commit.assignment.taskId,
                note: `${commit.details.join('; ')} [auto-logged]`,
                date: commit.date,
                durationSeconds: Math.round(commit.hours * 3600),
            });
            // Persisted per-commit (not once at the end) so a failure partway
            // through doesn't cause already-pushed entries to be re-sent on retry.
            for (const key of commit.keys) {
                alreadyCommitted[key] = true;
            }
            await updateStorage({ committedEntries: alreadyCommitted });
            pushedCount++;
        }
        console.log(`Pushed ${pushedCount} time log(s) to MyHours.`);
    });
    Program.command('interative').alias('i').action(async () => {
        const {note, tags, startTime} = await prompts([{
            message: 'What are you working on?',
            type: 'text',
            name: 'note',
            validate: (s) => s?.length,
        }, {
            message: 'Any tags? (comma seperated)',
            type: 'list',
            name: 'tags',
            separator: ','
        }, {
            message: 'Start time?',
            type: 'text',
            name: 'startTime',
            validate: (s) => { if (!s) { return true; } try { luxon.DateTime.fromISO(s).toJSDate(); return true; } catch { return false; }}
        }]);
        const startDate = startTime ? luxon.DateTime.fromISO(startTime).toJSDate() : undefined;
        const tagsFiltered = tags.filter((s: string) => !!s);
        const tagsDefs = tagsFiltered.length && await client.getOrCreateTags(tagsFiltered);
        const { id } = await client.addTimeLog(note, tagsDefs, startDate);
        console.log("Started new log: ", id);
    });

    return Program.parseAsync();
}

main().catch(ex => {
    console.error("Error running program", ex);
    process.exit(1);
});
