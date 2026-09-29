import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { IncrementalFile } from "../transcript/incremental.js";
import { transcriptFiles, writtenSince } from "../transcript/sessions.js";

/**
 * One API response of Claude, from the lines of its message in a transcript.
 * Times are epoch ms.
 */
export interface Response {
  /** The entry before its first line: the prompt or tool result it answers. */
  start: number;
  /** Its first line, i.e. its first finished block. */
  first: number;
  /** Its last line. */
  end: number;
  model: string;
  outputTokens: number;
}

/** An error Claude Code wrote into the transcript instead of an answer (e.g. a usage limit). */
export interface ApiError {
  at: number;
  text: string;
}

/** Responses too short, too long or too small to say anything about speed; they still count. */
export function measurable(r: Response): boolean {
  const secs = (r.end - r.start) / 1000;
  return secs >= 0.5 && secs <= 600 && r.outputTokens >= 50;
}

/** Output tokens per second over the whole response. */
export const speedOf = (r: Response) => r.outputTokens / ((r.end - r.start) / 1000);
/** Seconds until the first block was finished: an upper bound of the time to the first token. */
export const waitOf = (r: Response) => (r.first - r.start) / 1000;

interface Line {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  message?: { id?: string; model?: string; usage?: { output_tokens?: number }; content?: unknown };
}

const TIMESTAMP = /"timestamp":"([^"]+)"/;

/**
 * Reads the responses of one transcript as it grows. A subagent's lines and
 * the main conversation's are tracked apart, so a response is always timed
 * from its own prompt or tool result.
 */
export class ResponseReader {
  private file: IncrementalFile;
  private byId = new Map<string, Response>();
  private lastUserAt = new Map<boolean, number>();
  readonly errors: ApiError[] = [];

  constructor(readonly path: string) {
    this.file = new IncrementalFile(path, (line) => this.consume(line), () => this.reset());
  }

  /** Reads what was appended; returns whether anything changed. */
  update(): boolean {
    return this.file.update();
  }

  /** Feeds transcript text directly (used by tests). */
  push(text: string): void {
    this.file.push(text);
  }

  get responses(): Response[] {
    return [...this.byId.values()];
  }

  private reset(): void {
    this.byId.clear();
    this.lastUserAt.clear();
    this.errors.length = 0;
  }

  private consume(line: string): void {
    // User entries only move the start of the next response; skip parsing their (often large) content.
    if (line.includes('"type":"user"')) {
      const at = Date.parse(TIMESTAMP.exec(line)?.[1] ?? "");
      if (!Number.isNaN(at)) this.lastUserAt.set(line.includes('"isSidechain":true'), at);
      return;
    }
    if (!line.includes('"type":"assistant"')) return;
    let e: Line;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const at = Date.parse(e.timestamp ?? "");
    if (e.type !== "assistant" || Number.isNaN(at)) return;
    if (e.isApiErrorMessage) {
      const content = e.message?.content;
      const text = Array.isArray(content) ? content.map((b) => (b as { text?: string }).text ?? "").join(" ") : String(content ?? "");
      this.errors.push({ at, text: text.split("\n")[0].trim() || "API error" });
      return;
    }
    const id = e.message?.id;
    const model = e.message?.model;
    // Messages Claude Code makes up itself (interrupts, errors) have the model "<synthetic>".
    if (!id || !model || model.startsWith("<")) return;
    const start = this.lastUserAt.get(e.isSidechain === true);
    if (start === undefined) return;
    const known = this.byId.get(id);
    const tokens = e.message?.usage?.output_tokens ?? 0;
    if (known) {
      known.end = Math.max(known.end, at);
      known.outputTokens = Math.max(known.outputTokens, tokens);
    } else {
      this.byId.set(id, { start, first: at, end: at, model, outputTokens: tokens });
    }
  }
}

/** Subagent transcripts of the sessions next to `sessionFiles` (`<session>/subagents/agent-*.jsonl`). */
function subagentFiles(sessionFiles: string[]): string[] {
  const dirs = new Set(sessionFiles.map((f) => dirname(f)));
  const found: string[] = [];
  for (const dir of dirs) {
    let sessions: string[];
    try {
      sessions = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const sub = join(dir, session, "subagents");
      try {
        for (const name of readdirSync(sub)) if (name.endsWith(".jsonl")) found.push(join(sub, name));
      } catch {
        // No subagents in this session.
      }
    }
  }
  return found;
}

export interface Measurements {
  responses: Response[];
  errors: ApiError[];
}

/** The responses of all projects' transcripts, subagents included, kept up to date by reading only what was appended. */
export class ResponseIndex {
  private readers = new Map<string, ResponseReader>();

  /** With `since` (epoch ms), only transcripts written since then are read; the responses before it stay in. */
  async scan(onProgress?: (done: number, total: number) => void, since?: number): Promise<Measurements> {
    const main = transcriptFiles();
    const all = [...main, ...subagentFiles(main)];
    const files = writtenSince(all, since);
    let reported = Date.now();
    for (const [i, path] of files.entries()) {
      let reader = this.readers.get(path);
      if (!reader) this.readers.set(path, (reader = new ResponseReader(path)));
      reader.update();
      if (onProgress && Date.now() - reported > 250) {
        reported = Date.now();
        onProgress(i + 1, files.length);
      }
      await new Promise((r) => setImmediate(r));
    }
    const present = new Set(all);
    for (const path of this.readers.keys()) if (!present.has(path)) this.readers.delete(path);
    const responses: Response[] = [];
    const errors: ApiError[] = [];
    for (const reader of this.readers.values()) {
      responses.push(...reader.responses);
      errors.push(...reader.errors);
    }
    return { responses: responses.sort((a, b) => a.start - b.start), errors: errors.sort((a, b) => a.at - b.at) };
  }
}

/** The responses and errors from `since` (epoch ms) on; all without it. */
export function measuredSince(data: Measurements, since: number | undefined): Measurements {
  if (since === undefined) return data;
  return { responses: data.responses.filter((r) => r.start >= since), errors: data.errors.filter((e) => e.at >= since) };
}

/** "2026-09-27" in local time. */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Minutes since local midnight. */
const minuteOfDay = (at: number) => {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
};

/** The stretch of `minutes` a time falls into. */
export const bucketIndex = (at: number, minutes: number) => Math.floor(minuteOfDay(at) / minutes);

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One stretch of a day. */
export interface Bucket {
  /** Median output tokens per second, of the measurable responses. */
  speed?: number;
  /** Median seconds until the first block. */
  wait?: number;
  /** Responses started in it. */
  count: number;
  /** Of those, the ones long enough to time. */
  measured: number;
  errors: ApiError[];
}

/**
 * Speed and wait against the usual ones as one index: 100 = usual, higher =
 * better. The geometric mean of speed / usual speed and usual wait / wait, so
 * twice as fast counts as much as half the wait; one of them alone if the
 * other is missing.
 */
export function scoreOf(value: { speed?: number; wait?: number }, usual: { speed?: number; wait?: number }): number | undefined {
  const ratios: number[] = [];
  if (value.speed && usual.speed) ratios.push(value.speed / usual.speed);
  if (value.wait && usual.wait) ratios.push(usual.wait / value.wait);
  if (ratios.length === 0) return undefined;
  return 100 * Math.exp(ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length);
}

/** The index of each stretch of a day against the usual one at that time. */
export const bucketScores = (buckets: Bucket[], typical: Bucket[]) => buckets.map((b, i) => scoreOf(b, typical[i]));

/** The index of a whole day: the stretches' indexes, weighted by their timed responses (geometric mean). */
export function dayScore(buckets: Bucket[], typical: Bucket[]): number | undefined {
  let weight = 0;
  let sum = 0;
  bucketScores(buckets, typical).forEach((s, i) => {
    if (s === undefined || buckets[i].measured === 0) return;
    weight += buckets[i].measured;
    sum += buckets[i].measured * Math.log(s);
  });
  return weight ? Math.exp(sum / weight) : undefined;
}

/** `model` or, when undefined, all models. */
const ofModel = (model: string | undefined) => (r: Response) => model === undefined || r.model === model;

/** The day `day` in stretches of `minutes`, for `model` (all when undefined). */
export function dayBuckets(data: Measurements, day: string, minutes: number, model?: string): Bucket[] {
  const n = Math.ceil(1440 / minutes);
  const speeds: number[][] = Array.from({ length: n }, () => []);
  const waits: number[][] = Array.from({ length: n }, () => []);
  const buckets: Bucket[] = Array.from({ length: n }, () => ({ count: 0, measured: 0, errors: [] }));
  for (const r of data.responses) {
    if (dayKey(r.start) !== day || !ofModel(model)(r)) continue;
    const i = bucketIndex(r.start, minutes);
    buckets[i].count++;
    if (!measurable(r)) continue;
    buckets[i].measured++;
    speeds[i].push(speedOf(r));
    waits[i].push(waitOf(r));
  }
  for (const e of data.errors) if (dayKey(e.at) === day) buckets[bucketIndex(e.at, minutes)].errors.push(e);
  buckets.forEach((b, i) => {
    b.speed = median(speeds[i]);
    b.wait = median(waits[i]);
  });
  return buckets;
}

/** Typical speed, wait and count per stretch of the day: medians over the `days` days before `day`. */
export function typicalBuckets(data: Measurements, day: string, minutes: number, model?: string, days = 30): Bucket[] {
  const end = Date.parse(`${day}T00:00:00`);
  const from = end - days * 86_400_000;
  const n = Math.ceil(1440 / minutes);
  const speeds: number[][] = Array.from({ length: n }, () => []);
  const waits: number[][] = Array.from({ length: n }, () => []);
  // Counts per day and stretch, for the median over the days that had any responses at that time.
  const counts: Map<string, number>[] = Array.from({ length: n }, () => new Map());
  for (const r of data.responses) {
    if (r.start < from || r.start >= end || !ofModel(model)(r)) continue;
    const i = bucketIndex(r.start, minutes);
    const key = dayKey(r.start);
    counts[i].set(key, (counts[i].get(key) ?? 0) + 1);
    if (!measurable(r)) continue;
    speeds[i].push(speedOf(r));
    waits[i].push(waitOf(r));
  }
  return speeds.map((s, i) => ({
    speed: median(s),
    wait: median(waits[i]),
    count: median([...counts[i].values()]) ?? 0,
    measured: s.length,
    errors: [],
  }));
}

/** Models of the responses, the most recently used first. */
export function modelsByRecency(data: Measurements): string[] {
  const last = new Map<string, number>();
  for (const r of data.responses) last.set(r.model, Math.max(last.get(r.model) ?? 0, r.start));
  return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

/** Days with responses (of `model`, or all), newest first, with how many; today always leads. */
export function daysWithData(data: Measurements, model: string | undefined, now = Date.now()): { day: string; count: number; errors: number }[] {
  const days = new Map<string, { count: number; errors: number }>();
  days.set(dayKey(now), { count: 0, errors: 0 });
  for (const r of data.responses) {
    if (!ofModel(model)(r)) continue;
    const key = dayKey(r.start);
    const d = days.get(key) ?? { count: 0, errors: 0 };
    d.count++;
    days.set(key, d);
  }
  for (const e of data.errors) {
    const key = dayKey(e.at);
    const d = days.get(key) ?? { count: 0, errors: 0 };
    d.errors++;
    days.set(key, d);
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, d]) => ({ day, ...d }));
}
