import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import { homedir } from "os";
import path from "path";

const execFileAsync = promisify(execFile);

export interface RepoCommit {
    hash: string;
    authorDateIso: string;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(p: string): Promise<boolean> {
    try {
        await fs.stat(p);
        return true;
    } catch {
        return false;
    }
}

export async function discoverRepositories(rootDir: string = path.join(homedir(), "git")): Promise<string[]> {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const repos: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const entryPath = path.join(rootDir, entry.name);
        if (await pathExists(path.join(entryPath, ".git"))) {
            repos.push(entryPath);
            continue;
        }
        // Not a repo itself - some folders (e.g. ~/git/element) are just a
        // container for several repos, so check one level deeper for those.
        const nestedEntries = await fs.readdir(entryPath, { withFileTypes: true }).catch(() => []);
        for (const nestedEntry of nestedEntries) {
            if (!nestedEntry.isDirectory()) {
                continue;
            }
            const nestedPath = path.join(entryPath, nestedEntry.name);
            if (await pathExists(path.join(nestedPath, ".git"))) {
                repos.push(nestedPath);
            }
        }
    }
    return repos;
}

export async function getLastActivityMs(repoPath: string): Promise<number> {
    const candidates = [".git/logs/HEAD", ".git/HEAD", ".git/packed-refs"];
    let latest = 0;
    for (const candidate of candidates) {
        try {
            const stat = await fs.stat(path.join(repoPath, candidate));
            latest = Math.max(latest, stat.mtimeMs);
        } catch {
            // File may not exist, ignore.
        }
    }
    return latest;
}

export async function getRepoAuthorEmail(repoPath: string): Promise<string|null> {
    try {
        const email = await runGit(repoPath, ["config", "user.email"]);
        return email || null;
    } catch {
        return null;
    }
}

export async function getDefaultBranch(repoPath: string): Promise<string|null> {
    try {
        const ref = await runGit(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
        return ref.replace(/^refs\/remotes\/origin\//, "");
    } catch {
        // No origin/HEAD, fall through to local heuristics.
    }
    for (const candidate of ["main", "master"]) {
        try {
            await runGit(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
            return candidate;
        } catch {
            // Branch doesn't exist locally, try next candidate.
        }
    }
    return null;
}

export async function listLocalBranches(repoPath: string): Promise<string[]> {
    const output = await runGit(repoPath, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]);
    return output ? output.split("\n") : [];
}

export interface GetBranchCommitsOptions {
    branch: string;
    defaultBranch: string|null;
    email: string;
    sinceIso: string;
}

export async function getBranchCommits(repoPath: string, { branch, defaultBranch, email, sinceIso }: GetBranchCommitsOptions): Promise<RepoCommit[]> {
    const authorPattern = `${escapeRegExp(email)}>`;
    const isDefaultBranch = branch === defaultBranch;
    const revRange = (!isDefaultBranch && defaultBranch) ? `${defaultBranch}..${branch}` : branch;
    const args = [
        "log",
        revRange,
        "--no-merges",
        `--author=${authorPattern}`,
        `--since=${sinceIso}`,
        "--format=%H%x1f%aI",
    ];
    if (revRange === branch) {
        // Only restrict to commits made directly on this branch (excludes commits
        // that reached it solely via merging another branch in) when we're not
        // already scoped by a defaultBranch..branch range.
        args.splice(2, 0, "--first-parent");
    }
    let output: string;
    try {
        output = await runGit(repoPath, args);
    } catch {
        return [];
    }
    if (!output) {
        return [];
    }
    return output.split("\n").map(line => {
        const [hash, authorDateIso] = line.split("\x1f");
        return { hash, authorDateIso };
    });
}
