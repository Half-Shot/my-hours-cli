import * as luxon from "luxon";
import path from "path";
import {
    discoverRepositories,
    getBranchCommits,
    getDefaultBranch,
    getLastActivityMs,
    getRepoAuthorEmail,
    listLocalBranches,
    RepoCommit,
} from "./git-scan.js";

const MAX_HOURS_PER_DAY = 8;
const ACTIVITY_LOOKBACK_WEEKS = 3;

export interface BranchDayEntry {
    repoPath: string;
    repoName: string;
    branch: string;
    hours: number;
    commitCount: number;
    firstTime: string;
    lastTime: string;
}

export interface DaySummary {
    date: string;
    entries: BranchDayEntry[];
}

export function getWeekWindowStart(now: luxon.DateTime): luxon.DateTime {
    return now.minus({ days: now.weekday - 1 }).startOf("day");
}

export function isWeekend(dt: luxon.DateTime): boolean {
    return dt.weekday >= 6;
}

export function bucketCommitsByDay(commits: RepoCommit[], weekStart: luxon.DateTime, weekEnd: luxon.DateTime): Map<string, luxon.DateTime[]> {
    const buckets = new Map<string, luxon.DateTime[]>();
    for (const commit of commits) {
        const dt = luxon.DateTime.fromISO(commit.authorDateIso);
        // git's --since filters by committer date, not author date, so a commit
        // authored before this week but rebased/amended since will still be
        // returned by getBranchCommits (committer date is always >= author date,
        // so this can only let extra old commits through, never drop new ones).
        // Filter by the true author date here to exclude those stale commits, and
        // to enforce the upper bound too (needed when summarising a past week,
        // since getBranchCommits has no --until to avoid the same committer-date pitfall).
        if (!dt.isValid || dt < weekStart || dt > weekEnd || isWeekend(dt)) {
            continue;
        }
        const key = dt.toISODate();
        if (!key) {
            continue;
        }
        const existing = buckets.get(key);
        if (existing) {
            existing.push(dt);
        } else {
            buckets.set(key, [dt]);
        }
    }
    return buckets;
}

export function estimateHoursForBucket(dates: luxon.DateTime[]): number {
    const sorted = [...dates].sort((a, b) => a.toMillis() - b.toMillis());
    if (sorted.length === 1) {
        return 1;
    }
    const minutes = sorted[sorted.length - 1].diff(sorted[0], "minutes").minutes;
    return Math.max(1, Math.round(minutes / 60));
}

export function capDayToEightHours<T extends { hours: number }>(entries: T[]): T[] {
    const total = entries.reduce((sum, entry) => sum + entry.hours, 0);
    if (total <= MAX_HOURS_PER_DAY) {
        return entries;
    }
    const scale = MAX_HOURS_PER_DAY / total;
    return entries.map(entry => ({ ...entry, hours: entry.hours * scale }));
}

export interface WeekWindow {
    weekStart: luxon.DateTime;
    weekEnd: luxon.DateTime;
}

export function getWeekWindow(referenceDate?: luxon.DateTime): WeekWindow {
    const weekStart = getWeekWindowStart(referenceDate ?? luxon.DateTime.now());
    const weekEnd = weekStart.plus({ days: 4 }).endOf("day"); // Friday of that week
    return { weekStart, weekEnd };
}

export interface BuildWeekSummaryOptions {
    rootDir: string;
    referenceDate?: luxon.DateTime;
}

export async function buildWeekSummary({ rootDir, referenceDate }: BuildWeekSummaryOptions): Promise<DaySummary[]> {
    const { weekStart, weekEnd } = getWeekWindow(referenceDate);
    const sinceIso = weekStart.toISO() as string;
    // Based on the target week, not real "now", so summarising a past week doesn't
    // get its repos wrongly dropped for looking inactive relative to today.
    const activityCutoffMs = weekStart.minus({ weeks: ACTIVITY_LOOKBACK_WEEKS }).toMillis();

    // day -> list of raw entries (before capping) with per-commit dates so we can compute hours/commitCount/first/last together.
    const dayBuckets = new Map<string, { repoPath: string; repoName: string; branch: string; dates: luxon.DateTime[] }[]>();

    const repos = await discoverRepositories(rootDir);
    for (const repoPath of repos) {
        const lastActivityMs = await getLastActivityMs(repoPath);
        if (lastActivityMs < activityCutoffMs) {
            continue;
        }
        const email = await getRepoAuthorEmail(repoPath);
        if (!email) {
            console.warn(`Skipping ${repoPath}: no git user.email configured`);
            continue;
        }
        const defaultBranch = await getDefaultBranch(repoPath);
        const branches = await listLocalBranches(repoPath);
        const repoName = path.basename(repoPath);

        for (const branch of branches) {
            const commits = await getBranchCommits(repoPath, { branch, defaultBranch, email, sinceIso });
            if (!commits.length) {
                continue;
            }
            const byDay = bucketCommitsByDay(commits, weekStart, weekEnd);
            for (const [day, dates] of byDay) {
                const list = dayBuckets.get(day) ?? [];
                list.push({ repoPath, repoName, branch, dates });
                dayBuckets.set(day, list);
            }
        }
    }

    const days: DaySummary[] = [];
    for (const [date, buckets] of [...dayBuckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const rawEntries = buckets.map(bucket => {
            const sorted = [...bucket.dates].sort((a, b) => a.toMillis() - b.toMillis());
            return {
                repoPath: bucket.repoPath,
                repoName: bucket.repoName,
                branch: bucket.branch,
                hours: estimateHoursForBucket(bucket.dates),
                commitCount: sorted.length,
                firstTime: sorted[0].toFormat("HH:mm"),
                lastTime: sorted[sorted.length - 1].toFormat("HH:mm"),
            };
        });
        days.push({ date, entries: capDayToEightHours(rawEntries) });
    }
    return days;
}
