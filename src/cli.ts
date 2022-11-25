import prompts from "prompts";
import * as EmailValidator from 'email-validator';// Using ES6 modules with Babel or TypeScript
import { program as Program } from "commander";
import { addTimeLog, authenticateWithPassword, doRefreshToken, getCurrentTasks, getLogs, getOrCreateTags, insertLog, stopTimeLog, removeTimeLogsWithNote } from "./client";
import { MyHoursTask } from "./structures";
import * as luxon from "luxon";
import { getStorage, IStorage, storeStorage } from "./storage";

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
        return storage;
    }
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
    return storage;
}

async function getPrettyTaskList(accessToken: string, dateToCheck: Date, standup: boolean) {
    const rawTasks = await getLogs(accessToken, dateToCheck);
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
        const orderedTimesStart = taskSet.flatMap(t => t.times.map(time => Date.parse(time.startTime))).sort();
        const orderedTimesEnd = taskSet.flatMap(t => t.times.map(time => Date.parse(time.endTime))).sort();
        if (!taskSet[0].note) {
            throw Error("task missing note. This shouldn't happen");
        }
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
                console.log(`📋 ${luxon.DateTime.fromMillis(taskSet.start).toFormat('HH:mm')} - ${luxon.DateTime.fromMillis(taskSet.end).toFormat('HH:mm')} ${taskSet.duration} - ${taskSet.note} (${taskSet.tags.map(t => `#${t.name}`).join(',')})`);
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
        .argument('<note>', 'Task description').action(async (note: string, { tags, startTime }: Record<string, string>) => {
        const startDate = startTime ? luxon.DateTime.fromISO(startTime).toJSDate() : undefined;
        const tagsStr: undefined|string[] = tags?.split(',').map((s: string) => s.trim());
        const tagsDefs = tagsStr && await getOrCreateTags(accessToken, tagsStr);
        const { id } = await addTimeLog(accessToken, note, tagsDefs, startDate);
        console.log("Started new log: ", id);
    });
    Program.command('fudge')
        .description('Distribute hours across the week. Removes all previous fudged entries, creates new by splitting hours evenly across the week.')
        .option('-t, --tags <tag>', 'Comma seperated list of tags to apply')
        .requiredOption('-w, --weekBegins <day>', "Week begins on this day, defaults to last Tuesday.")
        .argument('<hoursProjectTask...>', 'Space-separated list of <Hours:ProjectId[:TaskID]>')
        .action(async (hoursProjectTask, {tags, weekBegins}) => {
        const tagsStr: undefined|string[] = tags?.split(',').map((s: string) => s.trim());
        const tagsDefs = tagsStr && await getOrCreateTags(accessToken, tagsStr);
        const startDate = new Date(weekBegins);
        for (let i = 0; i < 7; i++) {
            const currentDate = new Date(weekBegins);
            currentDate.setDate(currentDate.getDate() + i);
            await removeTimeLogsWithNote(accessToken, "auto_fudge", currentDate);
            // no data on saturday or sunday...
            if (currentDate.getDay() == 6 || currentDate.getDay() == 0) {
                                 // but the 0th day is the sabbath, and the 6th is equally bad for timesheets
                                 continue;
                        }
            hoursProjectTask.forEach(async function(ptd: string) {
                const ptdparts = ptd.split(":")
                const hours = Math.trunc(Number(ptdparts[0]) * 60 * 60 / 5);
                const projectId = ptdparts[1];
                let taskId = null;
                if (ptdparts.length > 2) {
                    taskId = ptdparts[2];
                }
                const { id } = await insertLog(accessToken, "auto_fudge", currentDate, hours, projectId, tagsDefs, taskId);
                console.log("Added log for ", currentDate, " hours ", hours, "id is ", id)
            });
        }
        });
    Program.command('running', { isDefault: true }).description('Get running tasks').action(async () => {
        const tasks = (await getCurrentTasks(accessToken)).filter(t => t.running);
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
        if (!taskIds.length) {
            console.log("There are no running tasks");
            return;
        }
        for (const taskId of taskIds) {
            const log = await stopTimeLog(accessToken, taskId);
            const time = luxon.Duration.fromMillis(log.duration * 1000).shiftTo('hours', 'minutes').toHuman({ unitDisplay: "short", maximumSignificantDigits: 2 });
            console.log(`Stopped task ${log.note || log.id}. Recorded ${time}`);
        }
        console.log("Stopped running task(s)");
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
        const tagsDefs = tagsFiltered.length && await getOrCreateTags(accessToken, tagsFiltered);
        const { id } = await addTimeLog(accessToken, note, tagsDefs, startDate);
        console.log("Started new log: ", id);
    });
    return Program.parseAsync();
}

main().catch(ex => {
    console.error("Error running program", ex);
    process.exit(1);
});
