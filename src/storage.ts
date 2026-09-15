import fs from "fs/promises";
import { homedir, platform } from "os";
import path from "path";

export interface BranchAssignment {
    projectId: number;
    projectName: string;
    taskId: number;
    taskName: string;
}

export interface IStorage {
    accessToken: string;
    branchAssignments?: Record<string, BranchAssignment|'skip'>;
    // undefined = never asked, null = asked and declined, string = configured.
    icalUrl?: string|null;
    // Keys already pushed to MyHours via commit-week, so re-running it for the
    // same week doesn't create duplicate time logs.
    committedEntries?: Record<string, true>;
}

function getStoragePath() {
    if (process.env.XDG_CONFIG_HOME) {
        return path.join(process.env.XDG_CONFIG_HOME, "my-hours-cli.json");
    }
    if (["linux", "darwin"].includes(platform())) {
        return path.join(homedir(), "/.config/my-hours-cli.json");
    }
    return path.join(homedir(), "my-hours-cli.json");
}

const configPath = getStoragePath();

export async function getStorage(): Promise<IStorage|null> {
    try {
        await fs.stat(configPath);
    } catch (ex) {
        return null;
    }
    const data = await fs.readFile(configPath, "utf-8");
    return JSON.parse(data);
}


export async function storeStorage(storage: IStorage): Promise<void> {
    await fs.writeFile(configPath, JSON.stringify(storage));
}

export async function updateStorage(partial: Partial<IStorage>): Promise<IStorage> {
    const existing = await getStorage();
    const updated = { ...existing, ...partial } as IStorage;
    await storeStorage(updated);
    return updated;
}
