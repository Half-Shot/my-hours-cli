import fetch from 'cross-fetch';
import { MyHoursTask } from "./structures";
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
        console.error(result);
        throw Error('Failed to authenticate');
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
        console.error(result);
        throw Error('Failed to authenticate');
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
        console.error(result);
        throw Error('Failed to get current tasks');
    }
    return result as MyHoursTask[];
}

export async function addTimeLog(accessToken: string, note: string) {
    const currentDate = new Date();
    const dateString = `${currentDate.getFullYear()}-${(currentDate.getMonth() + 1).toString().padStart(2, '0')}-${currentDate.getDate().toString().padStart(2, '0')}`;
    const res = await fetch("https://api2.myhours.com/api/logs/startNewLog", {
        body: JSON.stringify({
            projectId: null,
            taskId: null,
            date: dateString,
            start: new Date().toISOString(),
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
        console.error(result);
        throw Error('Failed to start timer');
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
        console.error(result);
        throw Error('Failed to stop timer');
    }
    return result;
}