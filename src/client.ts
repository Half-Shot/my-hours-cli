import fetch from 'cross-fetch';
import { MyHoursTag, MyHoursTask } from "./structures";
export async function authenticateWithPassword(email: string, password: string) {
    const res = await fetch("https://api2.myhours.com/api/tokens/login", {
        body: JSON.stringify({
            grantType: 'password',
            clientId: 'api',
            email,
            password,
        }),
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-version': '1.0'
        }
    });
    const result = await res.json();
    if (res.status !== 200) {
        throw new MyHoursApiError(result);
    }
    return result as {
        accessToken: string,
        refreshToken: string,
        expiresIn: number,
    }
}

export async function doRefreshToken(refreshToken: string) {
    const res = await fetch("https://api2.myhours.com/api/tokens/refresh", {
        body: JSON.stringify({
            grantType: 'refresh_token',
            refreshToken: refreshToken,
        }),
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-version': '1.0'
        }
    });
    const result = await res.json();
    if (res.status !== 200) {
        throw new MyHoursApiError(result);
    }
    return result as {
        accessToken: string,
        refreshToken: string,
        expiresIn: number,
    }
}

export async function getCurrentTasks(accessToken: string) {
    return getLogs(accessToken, new Date());
}

export async function getLogs(accessToken: string, date: Date) {
    const dateString = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
    const res = await fetch(`https://api2.myhours.com/api/logs?date=${dateString}&startIndex=0&step=1000`, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'api-version': '1.0'
        }
    });
    const result = await res.json();
    if (res.status !== 200) {
        throw new MyHoursApiError(result);
    }
    return result as MyHoursTask[];
}

export async function addTimeLog(accessToken: string, note: string, tags?: MyHoursTag[], startTime?: Date) {
    const currentDate = new Date();
    const dateString = `${currentDate.getFullYear()}-${(currentDate.getMonth() + 1).toString().padStart(2, '0')}-${currentDate.getDate().toString().padStart(2, '0')}`;
    const res = await fetch("https://api2.myhours.com/api/logs/startNewLog", {
        body: JSON.stringify({
            projectId: null,
            taskId: null,
            date: dateString,
            start: startTime?.toISOString(),
            tagIds: tags?.map(t => t.id),
            note,
            billable: false,
        }),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'api-version': '1.0'
        },
        method: 'POST'
    });
    const result = await res.json();
    if (res.status !== 201) {
        throw new MyHoursApiError(result);
    }
    return result as { id: string };
}

export async function stopTimeLog(accessToken: string, logId: number) {
    const res = await fetch("https://api2.myhours.com/api/logs/stopTimer", {
        body: JSON.stringify({
            logId,
            time: new Date().toISOString(),
        }),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'api-version': '1.0'
        },
        method: 'POST'
    });
    const result = await res.json();
    if (res.status !== 200) {
        throw new MyHoursApiError(result);
    }
    return result;
}

export async function createTag(accessToken: string, name: string) {
    const res = await fetch("https://api2.myhours.com/api/tags", {
        body: JSON.stringify({
            name,
            hexColor: "#007bff", // TODO: Customize this?
        }),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'api-version': '1.0'
        },
        method: 'POST'
    });
    const result = await res.json();
    if (res.status !== 201) {
        throw new MyHoursApiError(result);
    }
    return result as MyHoursTag;
}

export async function getAllTags(accessToken: string) {
    const res = await fetch("https://api2.myhours.com/api/tags/getalldx?hideArchived=true", {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'api-version': '1.0'
        },
        method: 'GET'
    });
    const result = await res.json();
    if (res.status !== 200) {
        throw new MyHoursApiError(result);
    }
    return result.data as MyHoursTag[];
}

export async function getOrCreateTags(accessToken: string, tags: string[]): Promise<MyHoursTag[]> {
    const allTags = await getAllTags(accessToken);
    const tagDefinitions = tags.map(tagName => allTags.find(t => t.name === tagName)).filter(t => !!t) as MyHoursTag[];
    for (const missingTagName of tags.filter(tagName => !allTags.find(t => t.name === tagName))) {
        const tag = await createTag(accessToken, missingTagName);
        tagDefinitions.push(tag);
    }
    return tagDefinitions;
}

export class MyHoursApiError extends Error {
    constructor(errorBody: {message: string, validationErrors: string[]}) {
        super(`ApiError ${errorBody.message}\n  ${errorBody.validationErrors.join('\n  ')}`)
    }
}