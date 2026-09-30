import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFavorites, toggleFavorite } from "../src/favorites.js";
import { claudeDir, projectDir, projectSlug } from "../src/transcript/locate.js";
import type { SessionSummary } from "../src/transcript/sessions.js";
import {
  emptyTrash,
  listTrash,
  purgeSession,
  restoreSession,
  runningSessionIds,
  runningSessions,
  sessionItems,
  trashSession,
} from "../src/transcript/trash.js";

const cwd = join(tmpdir(), "cco-trash-project");
const slug = projectSlug(cwd);
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

function registerRunning(id: string, pid: number, status?: string) {
  mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
  writeFileSync(join(claudeDir(), "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id, status }));
}

describe("trash", () => {
  it("moves every part of a session and records it", () => {
    createSession("s1");
    expect(sessionItems(projectDir(cwd), "s1")).toHaveLength(3);
    trashSession(summary("s1"));
    expect(sessionItems(projectDir(cwd), "s1")).toEqual([]);
    const [entry] = listTrash();
    expect(entry.id).toBe("s1");
    expect(entry.items).toHaveLength(3);
    for (const item of entry.items) expect(existsSync(item.to)).toBe(true);
  });

  it("moves a merged session with the sessions it continued from, and restores them together", () => {
    createSession("old");
    createSession("new");
    trashSession({ ...summary("new"), continues: ["old"] });
    expect(sessionItems(projectDir(cwd), "old")).toEqual([]);
    expect(listTrash()[0].items).toHaveLength(6);
    restoreSession(slug, "new");
    expect(sessionItems(projectDir(cwd), "old")).toHaveLength(3);
    expect(sessionItems(projectDir(cwd), "new")).toHaveLength(3);
  });

  it("restores a session with all its parts", () => {
    createSession("s1");
    trashSession(summary("s1"));
    restoreSession(slug, "s1");
    expect(sessionItems(projectDir(cwd), "s1")).toHaveLength(3);
    expect(readFileSync(join(claudeDir(), "file-history", "s1", "v1"), "utf8")).toBe("old");
    expect(listTrash()).toEqual([]);
  });

  it("refuses to restore over a session that exists again", () => {
    createSession("s1");
    trashSession(summary("s1"));
    writeFileSync(join(projectDir(cwd), "s1.jsonl"), "new");
    expect(() => restoreSession(slug, "s1")).toThrow(/exists again/);
    expect(readFileSync(join(projectDir(cwd), "s1.jsonl"), "utf8")).toBe("new");
    expect(listTrash()).toHaveLength(1);
  });

  it("deletes for good, one or all, and drops the mark", () => {
    createSession("s1");
    createSession("s2");
    toggleFavorite(cwd, "sessions", "s1");
    trashSession(summary("s1"));
    trashSession(summary("s2"));
    expect(readFavorites(cwd, "sessions")).toEqual(["s1"]);
    purgeSession(slug, "s1", cwd);
    expect(listTrash().map((e) => e.id)).toEqual(["s2"]);
    expect(readFavorites(cwd, "sessions")).toEqual([]);
    expect(emptyTrash(undefined, cwd)).toBe(1);
    expect(listTrash()).toEqual([]);
    // Nothing of the sessions is left behind.
    expect(sessionItems(projectDir(cwd), "s1")).toEqual([]);
  });

  it("keeps the trash per project and lists all of it without a project", () => {
    const other = join(tmpdir(), "cco-trash-other");
    mkdirSync(projectDir(other), { recursive: true });
    createSession("s1");
    writeFileSync(join(projectDir(other), "o1.jsonl"), "x");
    trashSession(summary("s1"));
    trashSession({ ...summary("o1"), path: join(projectDir(other), "o1.jsonl") });
    expect(listTrash(slug).map((e) => e.id)).toEqual(["s1"]);
    expect(listTrash(projectSlug(other)).map((e) => e.id)).toEqual(["o1"]);
    expect(listTrash().map((e) => e.id).sort()).toEqual(["o1", "s1"]);
    restoreSession(projectSlug(other), "o1");
    expect(existsSync(join(projectDir(other), "o1.jsonl"))).toBe(true);
  });

  it("refuses the active session and sessions running elsewhere", () => {
    createSession("s1");
    createSession("s2");
    expect(() => trashSession(summary("s1"), "s1")).toThrow(/active/);
    registerRunning("s2", process.pid);
    expect(runningSessionIds()).toEqual(new Set(["s2"]));
    expect(() => trashSession(summary("s2"))).toThrow(/running/);
    expect(sessionItems(projectDir(cwd), "s2")).toHaveLength(3);
  });

  it("reads what a running session is doing", () => {
    registerRunning("s4", process.pid, "busy");
    registerRunning("s5", process.ppid, "waiting");
    registerRunning("s6", 2 ** 22 + 12345, "busy");
    const activities = new Map([...runningSessions()].map(([id, r]) => [id, r.activity]));
    expect(activities).toEqual(new Map([["s4", "busy"], ["s5", "waiting"]]));
    registerRunning("s4", process.pid, "starting");
    expect(runningSessions().get("s4")).toEqual({ pid: process.pid });
  });

  it("reads the name and the job of a background session", () => {
    mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
    const info = { pid: process.pid, sessionId: "s7", name: "review", kind: "bg", jobId: "feec72a8", status: "idle" };
    writeFileSync(join(claudeDir(), "sessions", `${process.pid}.json`), JSON.stringify(info));
    expect(runningSessions().get("s7")).toEqual({ pid: process.pid, activity: "idle", name: "review", kind: "bg", jobId: "feec72a8" });
  });

  it("ignores registrations of processes that are gone", () => {
    registerRunning("s3", 2 ** 22 + 12345);
    expect(runningSessionIds()).toEqual(new Set());
  });
});
