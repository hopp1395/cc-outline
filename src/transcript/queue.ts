import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** How much of the transcript's end `ranFromQueue` reads. */
const TAIL_BYTES = 64 * 1024;
/** A dequeue older than this is not the command running now. */
const MAX_AGE_MS = 60_000;

/**
 * Whether the command running now was typed while Claude was working, from
 * the transcript's last lines: Claude Code queues it, writes an `enqueue` (only
 * then) and, at the end of the turn, a `dequeue`, and runs its `!` lines before
 * the prompt is written. So the last `dequeue`, with no `user` entry after it,
 * is that command. A prompt absorbed mid-turn is `remove`d instead.
 */
export function takenFromQueue(lines: string[], now: number, maxAge = MAX_AGE_MS): boolean {
  let dequeued: number | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { type?: string; operation?: string; timestamp?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "queue-operation" && entry.operation === "dequeue") dequeued = Date.parse(entry.timestamp ?? "");
    else if (entry.type === "user") dequeued = undefined;
  }
  return dequeued !== undefined && !Number.isNaN(dequeued) && now - dequeued <= maxAge;
}

/** `takenFromQueue` for the end of the transcript at `path`; false if it cannot be read. */
export function ranFromQueue(path: string | undefined, now = Date.now()): boolean {
  if (!path) return false;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    // The first line of a tail is usually cut.
    if (start > 0) lines.shift();
    return takenFromQueue(lines, now);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
