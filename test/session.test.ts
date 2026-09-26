import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleHook } from "../src/hook.js";
import { findLatestTranscript, projectDir, readActive, viewerFile, writeJson } from "../src/transcript/locate.js";
import { readControl, registerViewer, requestView, runningViewer, unregisterViewer } from "../src/viewer.js";

const cwd = join(tmpdir(), "cce-project");
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cce-config-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const hook = (event: string, session: string, reason?: string) =>
  handleHook({ hook_event_name: event, session_id: session, transcript_path: `/t/${session}.jsonl`, cwd, reason });

describe("handleHook", () => {
  it("records the active session and marks it ended on exit", () => {
    hook("SessionStart", "a");
    expect(readActive(cwd)).toMatchObject({ session_id: "a", transcript_path: "/t/a.jsonl" });
    expect(readActive(cwd)?.ended).toBeUndefined();
    hook("SessionEnd", "a", "prompt_input_exit");
    expect(readActive(cwd)).toMatchObject({ session_id: "a", ended: true });
  });

  it("ignores /clear and ends of sessions that are no longer active", () => {
    hook("SessionStart", "a");
    hook("SessionEnd", "a", "clear");
    expect(readActive(cwd)?.ended).toBeUndefined();
    hook("SessionStart", "b");
    hook("SessionEnd", "a", "other");
    expect(readActive(cwd)).toMatchObject({ session_id: "b" });
    expect(readActive(cwd)?.ended).toBeUndefined();
  });

  it("a new session start clears the ended flag", () => {
    hook("SessionStart", "a");
    hook("SessionEnd", "a", "other");
    hook("SessionStart", "a");
    expect(readActive(cwd)?.ended).toBeUndefined();
  });
});

describe("findLatestTranscript", () => {
  it("skips newer bookkeeping files without messages", () => {
    const dir = projectDir(cwd);
    mkdirSync(dir, { recursive: true });
    const real = join(dir, "real.jsonl");
    const stub = join(dir, "stub.jsonl");
    writeFileSync(real, '{"type":"user","message":{"content":"hi"}}\n');
    writeFileSync(stub, '{"type":"bridge-session","sessionId":"x"}\n');
    utimesSync(real, new Date(1000), new Date(1000));
    expect(findLatestTranscript(cwd)).toBe(real);
  });
});

describe("viewer registration", () => {
  it("reports the running viewer and forgets dead ones", () => {
    expect(runningViewer(cwd)).toBeUndefined();
    registerViewer(cwd);
    expect(runningViewer(cwd)).toBe(process.pid);
    unregisterViewer(cwd);
    expect(runningViewer(cwd)).toBeUndefined();
    writeJson(viewerFile(cwd), { pid: 2 ** 22 + 12345 });
    expect(runningViewer(cwd)).toBeUndefined();
  });

  it("passes view requests through the control file", () => {
    const before = Date.now();
    requestView(cwd, "git");
    const req = readControl(cwd);
    expect(req?.view).toBe("git");
    expect(req!.at).toBeGreaterThanOrEqual(before);
  });
});
