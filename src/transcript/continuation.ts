import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Claude Code can go on with a session under a new id, e.g. when /compact
 * sends it to the background. Only the old transcript says so: it ends with a
 * `continued-in` entry. The new one starts with the compact boundary and
 * copies of the last entries, but does not name the old one.
 */

/** How much of a transcript's end is searched for its `continued-in` entry. */
const TAIL_BYTES = 64 * 1024;
/** How much of its start is searched for its first conversation entry. */
const HEAD_BYTES = 64 * 1024;

const nextCache = new Map<string, { size: number; mtimeMs: number; next?: string }>();
const startCache = new Map<string, boolean>();

function readSlice(file: string, from: "start" | "end", bytes: number): { text: string; size: number; mtimeMs: number } | undefined {
  let fd: number | undefined;
  try {
    const { size, mtimeMs } = statSync(file);
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    fd = openSync(file, "r");
    const n = readSync(fd, buf, 0, length, from === "start" ? 0 : size - length);
    return { text: buf.subarray(0, n).toString("utf8"), size, mtimeMs };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** The session id the transcript `file` continued in, if it did. Cached until the file changes. */
export function continuedInOf(file: string): string | undefined {
  const slice = readSlice(file, "end", TAIL_BYTES);
  if (!slice) return undefined;
  const cached = nextCache.get(file);
  if (cached && cached.size === slice.size && cached.mtimeMs === slice.mtimeMs) return cached.next;
  let next: string | undefined;
  for (const line of slice.text.split("\n")) {
    if (!line.includes('"continued-in"')) continue;
    const entry = parse(line);
    if (entry?.type === "continued-in" && typeof entry.continuedInSessionId === "string") next = entry.continuedInSessionId;
  }
  nextCache.set(file, { size: slice.size, mtimeMs: slice.mtimeMs, next });
  return next;
}

/** Whether the transcript `file` begins where another left off: its first conversation entry is a compact boundary. */
export function startsWithCompact(file: string): boolean {
  const cached = startCache.get(file);
  if (cached !== undefined) return cached;
  const slice = readSlice(file, "start", HEAD_BYTES);
  if (!slice) return false;
  // The last line may be cut off.
  for (const line of slice.text.split("\n").slice(0, -1)) {
    const entry = parse(line);
    // Titles, modes and snapshots carry no uuid; the conversation starts with the first entry that does.
    if (!entry || typeof entry.uuid !== "string") continue;
    const result = entry.type === "system" && entry.subtype === "compact_boundary";
    startCache.set(file, result);
    return result;
  }
  return false;
}

/** The transcripts the session in `file` continued from, oldest first; empty for most sessions. */
export function predecessors(file: string): string[] {
  const chain: string[] = [];
  const seen = new Set([file]);
  let current = file;
  while (startsWithCompact(current)) {
    const id = basename(current, ".jsonl");
    const dir = dirname(current);
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      break;
    }
    const previous = names.map((n) => join(dir, n)).find((f) => !seen.has(f) && continuedInOf(f) === id);
    if (!previous) break;
    chain.unshift(previous);
    seen.add(previous);
    current = previous;
  }
  return chain;
}
