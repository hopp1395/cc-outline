import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFavorites, toggleFavorite } from "../src/favorites.js";
import { claudeDir, projectDir } from "../src/transcript/locate.js";
import type { SessionSummary } from "../src/transcript/sessions.js";
import {
  emptyTrash,
  listTrash,
  purgeSession,
  restoreSession,
  runningSessionIds,
  sessionItems,
  trashSession,
} from "../src/transcript/trash.js";

const cwd = join(tmpdir(), "cco-trash-project");
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-trash-"));
  mkdirSync(projectDir(cwd), { recursive: true });
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const summary = (id: string): SessionSummary => ({ id, path: join(projectDir(cwd), `${id}.jsonl`), prompts: [], plans: [], files: [] });

/** A session with transcript, folder and file history, but no session-env. */
function createSession(id: string) {
  writeFileSync(join(projectDir(cwd), `${id}.jsonl`), '{"type":"user"}\n');
  mkdirSync(join(projectDir(cwd), id, "subagents"), { recursive: true });
  writeFileSync(join(projectDir(cwd), id, "subagents", "a.jsonl"), "x");
  mkdirSync(join(claudeDir(), "file-history", id), { recursive: true });
  writeFileSync(join(claudeDir(), "file-history", id, "v1"), "old");
}

function registerRunning(id: string, pid: number) {
  mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
  writeFileSync(join(claudeDir(), "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id }));
}

describe("trash", () => {
  it("moves every part of a session and records it", () => {
    createSession("s1");
    expect(sessionItems(cwd, "s1")).toHaveLength(3);
    trashSession(cwd, summary("s1"));
    expect(sessionItems(cwd, "s1")).toEqual([]);
    const [entry] = listTrash(cwd);
    expect(entry.id).toBe("s1");
    expect(entry.items).toHaveLength(3);
    for (const item of entry.items) expect(existsSync(item.to)).toBe(true);
  });

  it("restores a session with all its parts", () => {
    createSession("s1");
    trashSession(cwd, summary("s1"));
    restoreSession(cwd, "s1");
    expect(sessionItems(cwd, "s1")).toHaveLength(3);
    expect(readFileSync(join(claudeDir(), "file-history", "s1", "v1"), "utf8")).toBe("old");
    expect(listTrash(cwd)).toEqual([]);
  });

  it("refuses to restore over a session that exists again", () => {
    createSession("s1");
    trashSession(cwd, summary("s1"));
    writeFileSync(join(projectDir(cwd), "s1.jsonl"), "new");
    expect(() => restoreSession(cwd, "s1")).toThrow(/exists again/);
    expect(readFileSync(join(projectDir(cwd), "s1.jsonl"), "utf8")).toBe("new");
    expect(listTrash(cwd)).toHaveLength(1);
  });

  it("deletes for good, one or all, and drops the mark", () => {
    createSession("s1");
    createSession("s2");
    toggleFavorite(cwd, "sessions", "s1");
    trashSession(cwd, summary("s1"));
    trashSession(cwd, summary("s2"));
    expect(readFavorites(cwd, "sessions")).toEqual(["s1"]);
    purgeSession(cwd, "s1");
    expect(listTrash(cwd).map((e) => e.id)).toEqual(["s2"]);
    expect(readFavorites(cwd, "sessions")).toEqual([]);
    expect(emptyTrash(cwd)).toBe(1);
    expect(listTrash(cwd)).toEqual([]);
    // Nothing of the sessions is left behind.
    expect(sessionItems(cwd, "s1")).toEqual([]);
  });

  it("refuses the active session and sessions running elsewhere", () => {
    createSession("s1");
    createSession("s2");
    expect(() => trashSession(cwd, summary("s1"), "s1")).toThrow(/active/);
    registerRunning("s2", process.pid);
    expect(runningSessionIds()).toEqual(new Set(["s2"]));
    expect(() => trashSession(cwd, summary("s2"))).toThrow(/running/);
    expect(sessionItems(cwd, "s2")).toHaveLength(3);
  });

  it("ignores registrations of processes that are gone", () => {
    registerRunning("s3", 2 ** 22 + 12345);
    expect(runningSessionIds()).toEqual(new Set());
  });
});
