import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { TIMING } from "../timing.js";
import { claudeDir, readJson, writeJson } from "../transcript/locate.js";
import { getUsage } from "./api.js";
import { RemoteError, type RemoteErrorKind } from "./credentials.js";
import { newerLimits, type LimitWindow, type RateLimits } from "./usage.js";

/**
 * The account's 5-hour and 7-day windows, read from claude.ai (`/api/oauth/usage`, as Claude Code's `/usage` does)
 * with the remote API setting. All viewers of a config folder share one read through `usage.json` in its cco folder:
 * a viewer asks only when the last read is older than `TIMING.quotaPoll`, and after a failure waits longer each time.
 */

/** The longest wait after failures in a row. */
const MAX_BACKOFF = 10 * 60_000;

/** What the viewers of an account keep of its windows. */
export interface QuotaFile {
  /** The windows of the last read that worked. */
  limits?: RateLimits;
  /** When that read was (ms). */
  fetchedAt?: number;
  /** When the next read is due (ms): set before a read, so the other viewers wait for it. */
  nextAt: number;
  /** Failed reads in a row. */
  failures: number;
  /** Why the last read failed; none after one that worked. */
  error?: { kind: RemoteErrorKind | "unknown"; message: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The file of the account of config folder `dir`. */
export const quotaFile = (dir = claudeDir()) => join(dir, "cco", "usage.json");

function window(raw: unknown, name: string): LimitWindow | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (!isObject(raw) || typeof raw.utilization !== "number" || !Number.isFinite(raw.utilization)) throw new RemoteError("format", `the usage's ${name} is not what claude.ai was known to send`);
  if (raw.resets_at === null || raw.resets_at === undefined) return { utilization: raw.utilization / 100 };
  const resets = typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) : NaN;
  if (Number.isNaN(resets)) throw new RemoteError("format", `the usage's ${name} has no time it starts anew`);
  return { utilization: raw.utilization / 100, resetsAt: Math.floor(resets / 1000) };
}

/**
 * The windows of an answer of `/api/oauth/usage`: `five_hour` and `seven_day`, each `null` or with `utilization`
 * (percent, 0–100) and `resets_at` (ISO, `null` before the window started). The rest (per model, extra usage) is left.
 */
export function parseUsage(raw: unknown, now = Date.now()): RateLimits {
  if (!isObject(raw) || !("five_hour" in raw) || !("seven_day" in raw)) throw new RemoteError("format", "claude.ai's usage is not what it was known to send");
  const fiveHour = window(raw.five_hour, "five_hour");
  const sevenDay = window(raw.seven_day, "seven_day");
  return { ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }), seen: new Date(now).toISOString() };
}

/** The file as kept, if it is one. */
export function readQuotaFile(dir?: string): QuotaFile | undefined {
  const stored = readJson<unknown>(quotaFile(dir));
  if (!isObject(stored) || typeof stored.nextAt !== "number") return undefined;
  const limits = isObject(stored.limits) && typeof stored.limits.seen === "string" ? (stored.limits as unknown as RateLimits) : undefined;
  const error = isObject(stored.error) && typeof stored.error.message === "string" ? (stored.error as QuotaFile["error"]) : undefined;
  return {
    ...(limits && { limits }),
    ...(typeof stored.fetchedAt === "number" && { fetchedAt: stored.fetchedAt }),
    nextAt: stored.nextAt,
    failures: typeof stored.failures === "number" ? stored.failures : 0,
    ...(error && { error }),
  };
}

function keep(dir: string | undefined, file: QuotaFile): QuotaFile {
  try {
    // The account's cco folder: writeJson makes only this viewer's.
    mkdirSync(dirname(quotaFile(dir)), { recursive: true });
    writeJson(quotaFile(dir), file);
  } catch {
    // The next check reads again; this viewer shows what it read.
  }
  return file;
}

/** The calls out, swapped by tests. */
export const quotaSource = { get: getUsage };

/**
 * The windows of the account of config folder `dir`, read anew from claude.ai if they are due (or `force`), else as
 * kept. The read is claimed in the file first, so the other viewers of the account do not ask as well.
 */
export async function refreshQuota(dir?: string, now = Date.now(), force = false): Promise<QuotaFile> {
  const kept = readQuotaFile(dir) ?? { nextAt: 0, failures: 0 };
  if (!force && now < kept.nextAt) return kept;
  keep(dir, { ...kept, nextAt: now + TIMING.quotaPoll });
  try {
    const limits = parseUsage(await quotaSource.get(dir), now);
    return keep(dir, { limits, fetchedAt: now, nextAt: now + TIMING.quotaPoll, failures: 0 });
  } catch (err) {
    const failures = kept.failures + 1;
    const error = err instanceof RemoteError ? { kind: err.kind, message: err.message } : { kind: "unknown" as const, message: (err as Error).message };
    return keep(dir, { ...kept, nextAt: now + Math.min(TIMING.quotaPoll * 2 ** failures, MAX_BACKOFF), failures, error });
  }
}

/** What a viewer shows of the account's windows. */
export interface Quota {
  /** The newest windows known; none once old ones have run out. */
  limits?: RateLimits;
  /** They are older than the reads should make them: claude.ai could not be asked. */
  stale: boolean;
  /** When they were read (ms). */
  seenAt?: number;
  /** Why the last read failed. */
  error?: string;
}

/**
 * What to show of `file` and of the windows the remote sessions' events reported (`reported`, `rate-limits.json`):
 * the newer of each. Windows older than three reads are stale, shown dim, and only until the 5-hour window they
 * name has started anew: then nothing is known of it.
 */
export function quotaOf(file: QuotaFile | undefined, reported: RateLimits | undefined, now = Date.now()): Quota {
  const error = file?.error?.message;
  const limits = newerLimits(file?.limits, reported);
  if (!limits) return { stale: false, ...(error && { error }) };
  const seenAt = Date.parse(limits.seen);
  const stale = !(now - seenAt <= 3 * TIMING.quotaPoll);
  const ranOut = stale && (limits.fiveHour?.resetsAt ?? Infinity) * 1000 <= now;
  return { ...(!ranOut && { limits }), stale, ...(!Number.isNaN(seenAt) && { seenAt }), ...(error && { error }) };
}
