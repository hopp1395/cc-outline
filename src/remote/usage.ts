import { join } from "node:path";
import stringWidth from "string-width";
import { claudeDir, readJson, writeJson } from "../transcript/locate.js";
import type { RemoteEvent } from "./api.js";

/** One usage window of the account (5 hours, 7 days): how much of it is used (0–1) and when it starts again. */
export interface LimitWindow {
  utilization: number;
  /** Unix seconds. */
  resetsAt: number;
}

/** The account's usage windows as the worker last reported them in a `rate_limit_event`, and when (`seen`, ISO). */
export interface RateLimits {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  seen: string;
}

/** What the usage line of a remote session's viewer shows: the context of its last answer, and the account's windows. */
export interface RemoteUsage {
  /** The tokens Claude read for its last answer of the main conversation (input, cache read and cache creation). */
  context?: number;
  limits?: RateLimits;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function limitWindow(v: unknown): LimitWindow | undefined {
  if (!isObject(v) || typeof v.utilization !== "number" || typeof v.resetsAt !== "number") return undefined;
  return { utilization: v.utilization, resetsAt: v.resetsAt };
}

/**
 * The windows of the newest `rate_limit_event` in `events`: `rate_limit_info.unifiedWindows` holds `five_hour` and
 * `seven_day` (2.1.310); an older shape with only the window that triggered it (`rateLimitType`, `utilization`,
 * `resetsAt`) gives that one.
 */
export function rateLimitsOf(events: RemoteEvent[]): RateLimits | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const { payload, createdAt } = events[i]!;
    if (payload.type !== "rate_limit_event" || !isObject(payload.rate_limit_info)) continue;
    const info = payload.rate_limit_info;
    const windows = isObject(info.unifiedWindows) ? info.unifiedWindows : {};
    const own = limitWindow(info);
    const fiveHour = limitWindow(windows.five_hour) ?? (info.rateLimitType === "five_hour" ? own : undefined);
    const sevenDay = limitWindow(windows.seven_day) ?? (info.rateLimitType === "seven_day" ? own : undefined);
    if (fiveHour || sevenDay) return { ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }), seen: createdAt ?? "" };
  }
  return undefined;
}

/**
 * The context of the newest answer of the main conversation in `events`: its `usage`'s input, cache read and cache
 * creation tokens. Answers of subagents (`parent_tool_use_id`) and the empty ones of an error (`<synthetic>`, all 0) are skipped.
 */
export function contextOf(events: RemoteEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const { payload } = events[i]!;
    if (payload.type !== "assistant" || (typeof payload.parent_tool_use_id === "string" && payload.parent_tool_use_id)) continue;
    const usage = isObject(payload.message) && isObject(payload.message.usage) ? payload.message.usage : undefined;
    if (!usage) continue;
    const tokens = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
    if (tokens > 0) return tokens;
  }
  return undefined;
}

/** The newer of each window: what one session reported may be older than what another one did. */
export function newerLimits(a: RateLimits | undefined, b: RateLimits | undefined): RateLimits | undefined {
  if (!a || !b) return a ?? b;
  const [old, recent] = a.seen <= b.seen ? [a, b] : [b, a];
  const fiveHour = recent.fiveHour ?? old.fiveHour;
  const sevenDay = recent.sevenDay ?? old.sevenDay;
  return { ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }), seen: recent.seen };
}

/** The account's windows as any viewer last read them, in its config folder's cco folder. */
export const rateLimitsFile = () => join(claudeDir(), "cco", "rate-limits.json");

/** The windows kept for this account, if the file holds them. */
export function readRateLimits(): RateLimits | undefined {
  const stored = readJson<unknown>(rateLimitsFile());
  if (!isObject(stored) || typeof stored.seen !== "string") return undefined;
  const fiveHour = limitWindow(stored.fiveHour);
  const sevenDay = limitWindow(stored.sevenDay);
  return { ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }), seen: stored.seen };
}

/**
 * `limits` merged into those kept for the account (`newerLimits`), written when that changed them: the newest each
 * viewer read, so a session whose own report lies beyond the events read shows the account's too.
 */
export function keepRateLimits(limits: RateLimits | undefined): RateLimits | undefined {
  const stored = readRateLimits();
  const merged = newerLimits(stored, limits);
  if (merged && JSON.stringify(merged) !== JSON.stringify(stored)) {
    try {
      writeJson(rateLimitsFile(), merged);
    } catch {
      // Only a help for the next read: the line shows what this one read.
    }
  }
  return merged;
}

/** `62k`, `1.2M`: the context's size, short. */
export function shortTokens(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** The time until `resetsAt` (Unix seconds), coarse: `3d4h`, `2h14m`, `9m`; none once it has passed. */
export function untilReset(resetsAt: number, now: number): string | undefined {
  const s = Math.floor(resetsAt - now / 1000);
  if (s <= 0) return undefined;
  if (s >= 86400) return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`;
}

/** One part of the usage line: `label`, then `value` coloured by `level`, then `rest` dim. */
export interface UsagePart {
  label: string;
  value: string;
  level?: "low" | "mid" | "high";
  rest?: string;
}

const levelOf = (percent: number): UsagePart["level"] => (percent >= 80 ? "high" : percent >= 50 ? "mid" : "low");

/**
 * The parts of the usage line: `Ctx 62k`, `5h 23% 2h14m`, `7d 97% 3d4h`. A window whose reset has passed shows `–`:
 * it started anew and what it holds now is not known. None at all when nothing is known.
 */
export function usageParts(usage: RemoteUsage, now: number): UsagePart[] {
  const parts: UsagePart[] = [];
  if (usage.context !== undefined) parts.push({ label: "Ctx", value: shortTokens(usage.context) });
  for (const [label, window] of [["5h", usage.limits?.fiveHour], ["7d", usage.limits?.sevenDay]] as const) {
    if (!window) continue;
    const left = untilReset(window.resetsAt, now);
    if (!left) {
      parts.push({ label, value: "–" });
      continue;
    }
    const percent = Math.round(window.utilization * 100);
    parts.push({ label, value: `${percent}%`, level: levelOf(percent), rest: left });
  }
  return parts;
}

/** The columns `parts` take, joined by ` · `. */
export const usageWidth = (parts: UsagePart[]): number =>
  parts.reduce((sum, p, i) => sum + (i > 0 ? 3 : 0) + stringWidth(`${p.label} ${p.value}${p.rest ? ` ${p.rest}` : ""}`), 0);

/**
 * What of `parts` fits in `room` columns: all, else without the times left, then without `Ctx`, then `5h` alone;
 * none when not even that fits.
 */
export function fitUsage(parts: UsagePart[], room: number): UsagePart[] {
  const lean = parts.map(({ rest: _, ...p }) => p);
  const steps = [parts, lean, lean.filter((p) => p.label !== "Ctx"), lean.filter((p) => p.label === "5h")];
  return steps.find((s) => s.length > 0 && usageWidth(s) <= room) ?? [];
}
