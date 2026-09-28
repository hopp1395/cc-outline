import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeFile, continueSession, projectSlug, readJson, writeJson, type ActiveSession } from "../src/transcript/locate.js";

const saved = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
});

const win = process.platform === "win32";

describe("projectSlug", () => {
  it("replaces every non-alphanumeric character", () => {
    expect(projectSlug(win ? "W:\\repos\\claude-code-markdown" : "/repos/claude-code-markdown")).toBe(
      win ? "W--repos-claude-code-markdown" : "-repos-claude-code-markdown",
    );
    expect(projectSlug(win ? "C:\\Kopfhörer" : "/Kopfhörer")).toMatch(/-Kopfh-rer$/);
  });
});

describe("continueSession", () => {
  it("makes the transcript a session continued in the process's session, without its end", () => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-continue-"));
    const cwd = join(tmpdir(), "project");
    const old = { session_id: "a", transcript_path: join(tmpdir(), "a.jsonl"), cwd, updated: "" };
    writeJson(claudeFile(cwd, 7), { ...old, ended: true });
    const next = join(tmpdir(), "b.jsonl");
    continueSession(cwd, 7, old.transcript_path, next);
    expect(readJson(claudeFile(cwd, 7))).toMatchObject({ session_id: "b", transcript_path: next, cwd });
    expect(readJson<ActiveSession>(claudeFile(cwd, 7))?.ended).toBeUndefined();
    // No state of that process: nothing to continue.
    continueSession(cwd, 8, old.transcript_path, next);
    expect(readJson(claudeFile(cwd, 8))).toBeUndefined();
  });

  it("leaves a process alone whose session is another one by now (/resume)", () => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-continue-"));
    const cwd = join(tmpdir(), "project");
    const resumed = { session_id: "r", transcript_path: join(tmpdir(), "r.jsonl"), cwd, updated: "" };
    writeJson(claudeFile(cwd, 7), resumed);
    continueSession(cwd, 7, join(tmpdir(), "a.jsonl"), join(tmpdir(), "b.jsonl"));
    expect(readJson(claudeFile(cwd, 7))).toEqual(resumed);
  });
});
