import { dayKey } from "../monitor/responses.js";

/** What list entries are grouped by under a separator: the day ("2026-09-27") or the year ("2026"). */
export type Period = "day" | "year";

/** "2026-09-27" (local time) of an ISO timestamp, epoch ms or a day key; undefined without one. */
export function dayOf(at: string | number | undefined): string | undefined {
  if (at === undefined || at === "") return undefined;
  // A day key as such: Date.parse would read it as UTC midnight, the day before west of Greenwich.
  if (typeof at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  const ms = typeof at === "number" ? at : Date.parse(at);
  return Number.isNaN(ms) ? undefined : dayKey(ms);
}

/** The group key of a time: its day, or its year. */
export function periodOf(at: string | number | undefined, period: Period): string | undefined {
  const day = dayOf(at);
  return period === "year" ? day?.slice(0, 4) : day;
}

/**
 * "Sun 27 Sep" for "2026-09-27". The year is added always (`"always"`), when
 * it is not the current one (`"other"`, the default) or never (`"never"`).
 */
export function dayLabel(day: string, year: "always" | "other" | "never" = "other", now = Date.now()): string {
  // Written out, since ICU versions differ ("Sep" or "Sept").
  const d = new Date(`${day}T12:00:00`);
  const label = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const withYear = year === "always" || (year === "other" && d.getFullYear() !== new Date(now).getFullYear());
  return withYear ? `${label} ${d.getFullYear()}` : label;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The name of a group key: "Sun 27 Sep" (with `year`, see dayLabel) for a day, "2026" for a year. */
export function periodLabel(key: string, year: "always" | "other" = "other"): string {
  return key.length === 4 ? key : dayLabel(key, year);
}

/** "── Sun 27 Sep 2026 ─────" (or "── 2026 ───") across `width` columns. */
export function separatorText(key: string, width: number): string {
  const head = `── ${periodLabel(key, "always")} `;
  return head + "─".repeat(Math.max(0, width - head.length));
}

/**
 * The group (day or year) each entry belongs to, for separators: an entry
 * without one belongs to the one before it (at the start, to the first entry
 * with one). Undefined when there are no separators: all entries are from
 * today, or this year (or none has a time). Otherwise every group, the first
 * and the current one too, gets one.
 */
export function entryGroups(keys: (string | undefined)[], period: Period = "day", now = Date.now()): string[] | undefined {
  const filled = fillDays(keys);
  const current = periodOf(now, period);
  return filled?.every((k) => k === current) ? undefined : filled;
}

/** `keys` with the gaps filled from the entry before (at the start, from the first key); undefined without any. */
export function fillDays(keys: (string | undefined)[]): string[] | undefined {
  const first = keys.find((k) => k !== undefined);
  if (first === undefined) return undefined;
  let current = first;
  return keys.map((k) => (current = k ?? current));
}

/**
 * Pre-rendered lines of timed entries with a separator line (indented by
 * `indent`, `width` columns in all) above each day's first entry.
 */
export function linesByDay<T>(
  items: T[],
  time: (item: T) => string | number | undefined,
  line: (item: T) => string,
  width: number,
  indent = "  ",
): string[] {
  const before = separatorsAt(fillDays(items.map((item) => dayOf(time(item)))));
  return items.flatMap((item, i) => {
    const day = before[i];
    const sep = day ? [`${indent}\u001b[2m${separatorText(day, width - indent.length)}\u001b[22m`] : [];
    return [...sep, line(item)];
  });
}

/**
 * Whether separators go before the entries: `separatorsAt(keys)[i]` is the
 * group to announce before entry i, or undefined.
 */
export function separatorsAt(keys: string[] | undefined): (string | undefined)[] {
  if (!keys) return [];
  return keys.map((k, i) => (i === 0 || keys[i - 1] !== k ? k : undefined));
}
