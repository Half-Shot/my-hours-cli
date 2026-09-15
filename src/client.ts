import { MyHoursProject, MyHoursProjectTask, MyHoursProjectTaskList, MyHoursTag, MyHoursTask } from "./structures.js";

export class MyHoursApiError extends Error {
    constructor(public readonly statusCode: number, {message, validationErrors}: { message: string, validationErrors?: string[] }) {
        super(`ApiError ${statusCode} ${message}\n  ${validationErrors?.join('\n  ')}`)
    }
}

function dateToParameter(date: Date) {
    return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
}

export class MyHoursClient {

    constructor(private readonly accessToken: string) {

    }

    private async doRequest(path: string, method = "GET", body?: Record<string, unknown>): Promise<unknown> {
        const url = new URL(path, "https://api2.myhours.com");
        const res = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `ApiKey ${this.accessToken}`,
                'api-version': '1.0'
            },
            method,
            body: body && JSON.stringify(body),
        });
        const contentType = res.headers.get("Content-Type");
        if (res.headers.get("Content-Type")?.split(";", 2)[0] === "application/json") {
            const result = await res.json();
            if (!res.ok) {
                throw new MyHoursApiError(res.status, result);
            }
            return result;
        }
        if (res.ok) {
            throw new Error(`Response from MyHours was unexpected content-type "${contentType}"`);
        }
        const message = await res.text();
        throw new MyHoursApiError(res.status, {message});
    }

    public async getLogs(date: Date): Promise<MyHoursTask[]> {
        return await this.doRequest(`/api/Logs?date=${dateToParameter(date)}&startIndex=0&step=1000`) as MyHoursTask[];
    }

    public async getCurrentTasks(): Promise<MyHoursTask[]> {
        return this.getLogs(new Date());
    }

    public async addTimeLog(note: string, tags?: MyHoursTag[], startTime?: Date): Promise<{id: string}> {
        return await this.doRequest("/api/logs/startNewLog", "POST", {
            projectId: null,
            taskId: null,
            date: dateToParameter(new Date()),
            start: startTime?.toISOString(),
            tagIds: tags?.map(t => t.id),
            note,
            billable: false,
        }) as { id: string };
    }

    public async insertLog(input: { projectId: number, taskId: number, note: string, date: string, durationSeconds: number }): Promise<MyHoursTask> {
        return await this.doRequest("/api/Logs/insertlog", "POST", {
            projectId: input.projectId,
            taskId: input.taskId,
            note: input.note,
            date: input.date,
            duration: input.durationSeconds,
        }) as MyHoursTask;
    }

    public async stopTimeLog(logId: number): Promise<MyHoursTask> {
        return await this.doRequest("/api/logs/stopTimer", "POST", {
            logId,
            time: new Date().toISOString(),
        }) as MyHoursTask;
    }

    public async createTag(name: string, hexColor = "#007bff"): Promise<MyHoursTag> {
        return await this.doRequest("/api/Tags", "POST", {
            name,
            hexColor,
        }) as MyHoursTag;
    }

    public async getAllTags(): Promise<MyHoursTag[]> {
        const {data} = await this.doRequest("/api/Tags", "GET") as { data: MyHoursTag[] };
        return data.filter(t => t.dateArchived === null);
    }

    public async getActiveProjects(): Promise<MyHoursProject[]> {
        return await this.doRequest("/api/Projects") as MyHoursProject[];
    }

    public async getProjectTasks(projectId: number): Promise<MyHoursProjectTask[]> {
        const lists = await this.doRequest(`/api/Projects/${projectId}/tasklist`) as MyHoursProjectTaskList[];
        return lists.flatMap(list => [...list.completedTasks, ...list.incompletedTasks]);
    }

    public async createProjectTask(projectId: number, name: string): Promise<MyHoursProjectTask> {
        return await this.doRequest(`/api/Projects/${projectId}/task`, "POST", { name }) as MyHoursProjectTask;
    }

    public async getOrCreateTags(tags: string[]): Promise<MyHoursTag[]> {
        const allTags = await this.getAllTags();
        const tagDefinitions = tags.map(tagName => allTags.find(t => t.name === tagName)).filter(t => !!t) as MyHoursTag[];
        for (const missingTagName of tags.filter(tagName => !allTags.find(t => t.name === tagName))) {
            const tag = await this.createTag(missingTagName);
            tagDefinitions.push(tag);
        }
        return tagDefinitions;
    }
}
