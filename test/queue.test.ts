import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ranFromQueue, takenFromQueue } from "../src/transcript/queue.js";

const now = Date.parse("2026-09-30T10:51:02.000Z");
const op = (operation: string, timestamp: string, content?: string) =>
  JSON.stringify({ type: "queue-operation", operation, timestamp, sessionId: "s", ...(content ? { content } : {}) });
const user = (content: string) => JSON.stringify({ type: "user", message: { role: "user", content }, timestamp: "2026-09-30T10:50:32.548Z" });
const assistant = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } });
const turnEnd = JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 18188 });

describe("takenFromQueue", () => {
  it("sees a command typed while Claude was working, run at the end of the turn", () => {
    const lines = [user("test it"), op("enqueue", "2026-09-30T10:50:41.537Z", "/cco:chat"), assistant, turnEnd, op("dequeue", "2026-09-30T10:51:01.172Z"), ""];
    expect(takenFromQueue(lines, now)).toBe(true);
  });

  it("does not count a command typed while Claude was idle", () => {
    expect(takenFromQueue([user("test it"), assistant, turnEnd], now)).toBe(false);
  });

  it("ends with the prompt of the dequeued command, or a later one", () => {
    const lines = [op("enqueue", "2026-09-30T10:50:41.537Z", "/cco:chat"), op("dequeue", "2026-09-30T10:51:01.172Z"), user("<command-name>/cco:chat</command-name>")];
    expect(takenFromQueue(lines, now)).toBe(false);
  });

  it("does not count a prompt absorbed mid-turn, or a dequeue long ago", () => {
    expect(takenFromQueue([op("enqueue", "2026-09-30T10:50:41.537Z", "more"), op("remove", "2026-09-30T10:50:45.000Z", "more")], now)).toBe(false);
    expect(takenFromQueue([op("dequeue", "2026-09-30T10:40:00.000Z")], now)).toBe(false);
  });

  it("skips lines it cannot parse", () => {
    expect(takenFromQueue(["{\"type\":\"us", op("dequeue", "2026-09-30T10:51:01.172Z")], now)).toBe(true);
  });
});

describe("ranFromQueue", () => {
  it("reads the end of the transcript, and is false without one", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cco-queue-")), "s.jsonl");
    writeFileSync(file, `${"x".repeat(100_000)}\n${user("go")}\n${op("dequeue", "2026-09-30T10:51:01.172Z")}\n`);
    expect(ranFromQueue(file, now)).toBe(true);
    expect(ranFromQueue(join(file, "missing"), now)).toBe(false);
    expect(ranFromQueue(undefined, now)).toBe(false);
  });
});
