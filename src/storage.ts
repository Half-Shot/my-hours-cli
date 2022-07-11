import fs from "fs/promises";
import { homedir } from "os";
import path from "path";

export interface IStorage {
    email: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

const configPath = path.join((process.env.XDG_CONFIG_HOME || homedir()), "my-hours-cli.json");

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
