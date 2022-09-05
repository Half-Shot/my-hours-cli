import fs from "fs/promises";
import { homedir, platform } from "os";
import path from "path";

export interface IStorage {
    email: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
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
