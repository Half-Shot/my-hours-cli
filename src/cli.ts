import fs from "fs/promises";
import { homedir } from "os";
import path from "path";
import prompts from "prompts";
import * as EmailValidator from 'email-validator';// Using ES6 modules with Babel or TypeScript
import { program as Program } from "commander";
import { addTimeLog, authenticateWithPassword, doRefreshToken, getCurrentTasks, getLogs, getOrCreateTags, stopTimeLog } from "./client";
import { MyHoursTask } from "./structures";
import * as luxon from "luxon";

interface IStorage {
    email: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

const configPath = path.join((process.env.XDG_CONFIG_HOME || homedir()), "my-hours-cli.json");

async function getStorage(): Promise<IStorage|null> {
    try {
        await fs.stat(configPath);
    } catch (ex) {
        return null;
    }
    const data = await fs.readFile(configPath, "utf-8");
    return JSON.parse(data);
}


async function storeStorage(storage: IStorage): Promise<void> {
    await fs.writeFile(configPath, JSON.stringify(storage));
}


async function ensureAuthenticated() {
    let storage: IStorage|null;
    try {
        storage = await getStorage();
    } catch (ex) {
        throw Error('Could not open storage for reading. ' + ex);
    }
    if (!storage) {
        // New config
        const {email, password} = await prompts([{
            message: 'What is your MyHours email address?',
            type: 'text',
            name: 'email',
            validate: EmailValidator.validate,
        }, {
            message: 'What is your MyHours password?',
            type: 'password',
            name: 'password'
        }]);
        const date = Date.now();
        const { accessToken, refreshToken, expiresIn } = await authenticateWithPassword(email, password);
        storage = {
            email,
            accessToken,
            refreshToken,
            expiresAt: date + (expiresIn * 1000)
        }
        await storeStorage(storage);
        console.log("Stored new configuration");
    } else {
        if (Date.now() >= storage.expiresAt) {
            console.debug("Refreshed token");
            const date = Date.now();
            const { accessToken, refreshToken, expiresIn } = await doRefreshToken(storage.refreshToken);
            storage = {
                ...storage,
                accessToken,
                refreshToken,
                expiresAt: date + (expiresIn * 1000),
            }
            await storeStorage(storage);
        }
    }
    return storage;
}

async function getPrettyTaskList(accessToken: string, dateToCheck: Date, standup: boolean) {
    const rawTasks = await getLogs(accessToken, dateToCheck);
    const tasks = Object.values(rawTasks.reduce<Record<string, MyHoursTask[]>>((taskSet, task) => {
        if (taskSet[task.note]) {
            taskSet[task.note].push(task);
        } else {
            taskSet[task.note] = [task];
        }
        return taskSet;
    }, {})).map(taskSet => {
        const orderedTimesStart = taskSet.flatMap(t => t.times.map(time => Date.parse(time.startTime))).sort();
        const orderedTimesEnd = taskSet.flatMap(t => t.times.map(time => Date.parse(time.endTime))).sort();
        return {
            ids: taskSet.map(t => t.id),
            start: orderedTimesStart[0],
            end: orderedTimesEnd[orderedTimesEnd.length-1],
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
                console.log(`📋 ${luxon.DateTime.fromMillis(taskSet.start).toFormat('HH:mm')} - ${luxon.DateTime.fromMillis(taskSet.end).toFormat('HH:mm')} ${taskSet.duration} - ${taskSet.note} ${taskSet.tags.map(t => `#${t.name}`).join(',')} `);
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
    const { accessToken } = await ensureAuthenticated();
    Program.command('start')
        .description('Track a new task')
        .option('-t, --tags <tag>', 'Comma seperated list of tags to apply')
        .option('-s, --startTime <time>', 'Comma seperated list of tags to apply')
        .argument('<note>', 'Task description').action(async (note, { tags, startTime }) => {
        const startDate = startTime && luxon.DateTime.fromISO(startTime).toJSDate();
        const tagsStr: undefined|string[] = tags?.split(',').map((s: string) => s.trim());
        const tagsDefs = tagsStr && await getOrCreateTags(accessToken, tagsStr);
        const { id } = await addTimeLog(accessToken, note, tagsDefs, startDate);
        console.log("Started new log: ", id);
    });
    Program.command('running').description('Get running tasks').action(async () => {
        const tasks = (await getCurrentTasks(accessToken)).filter(t => t.running);
        if (tasks.length) {
            tasks.forEach(task => {
                console.log(` 📋 ${task.id} - ${task.note}`);
            });
        } else {
            console.log("There are no tasks");
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
        await getPrettyTaskList(accessToken, dateToCheck, standup);
    });
    Program.command('today').description('Get tasks for today').option('-s, --standup').option('-d, --date <date>').action(async ({standup}) => {
        await getPrettyTaskList(accessToken, new Date(), standup);
    });
    Program.command('stop').description('Stop a task.').argument('[taskId]', 'Task ID. If ommitted, will stop all running tasks.').action(async (taskId) => {
        let taskIds: number[];
        if (!taskId) {
            taskIds = (await getCurrentTasks(accessToken)).filter(t => t.running).map(t => t.id);
        } else {
            taskIds = [parseInt(taskId)];
        }
        if (taskIds.length) {
            console.log("There are no running tasks");
            return;
        }
        for (const taskId of taskIds) {
            await stopTimeLog(accessToken, taskId);
        }
        console.log("Stopped running task(s)");
    });

    return Program.parseAsync();
}

main().catch(ex => {
    console.error("Error running program", ex);
    process.exit(1);
})