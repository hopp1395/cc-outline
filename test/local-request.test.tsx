import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleHook } from "../src/hook.js";
import { clearLocalRequest, localRequestFile, localRequestSummary, readLocalRequest, recordLocalRequest } from "../src/localRequest.js";
import { setOwnSettings } from "../src/settings.js";
import { claudeDir, projectDir, readActive } from "../src/transcript/locate.js";
import { RcViewerApp } from "../src/tui/RcViewerApp.js";
import { renderInk, until } from "./helpers/ink.js";

const QUESTION = { questions: [{ question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Blue", description: "" }, { label: "Green", description: "" }] }] };

describe("what a session of this machine asks, recorded by its hooks", () => {
  const saved = { ...process.env };
  let cwd: string;
  beforeEach(() => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-local-request-"));
    cwd = mkdtempSync(join(tmpdir(), "cco-local-request-project-"));
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("is written by PreToolUse of AskUserQuestion and PermissionRequest, and nothing else of the session's state", () => {
    const transcript = join(cwd, "s1.jsonl");
    handleHook({ hook_event_name: "PreToolUse", session_id: "s1", transcript_path: transcript, cwd, tool_name: "AskUserQuestion", tool_input: QUESTION } as never);
    expect(readLocalRequest("s1", transcript)).toMatchObject({ kind: "question", toolName: "AskUserQuestion", input: QUESTION });
    // The hook only records: the project's active session is not touched.
    expect(readActive(cwd)).toBeUndefined();
    handleHook({ hook_event_name: "PermissionRequest", session_id: "s1", transcript_path: transcript, cwd, tool_name: "Bash", tool_input: { command: "npm test" } } as never);
    const permission = readLocalRequest("s1", transcript)!;
    expect(permission).toMatchObject({ kind: "permission", toolName: "Bash" });
    expect(localRequestSummary(permission, 60)).toBe("allow Bash: $ npm test");
    // Another tool's PreToolUse is not a question.
    recordLocalRequest({ hook_event_name: "PreToolUse", session_id: "s2", tool_name: "Read", tool_input: { file_path: "a" } });
    expect(existsSync(localRequestFile("s2"))).toBe(false);
    // A prompt typed afterwards answers it.
    handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", transcript_path: transcript, cwd });
    expect(existsSync(localRequestFile("s1"))).toBe(false);
  });

  it("counts only while nothing was written to the transcript after it", () => {
    const transcript = join(cwd, "s1.jsonl");
    writeFileSync(transcript, "{}\n");
    const at = Date.now();
    utimesSync(transcript, new Date(at - 5000), new Date(at - 5000));
    recordLocalRequest({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "AskUserQuestion", tool_input: QUESTION }, at);
    expect(readLocalRequest("s1", transcript)?.kind).toBe("question");
    // Answered: Claude Code writes the call and its result.
    utimesSync(transcript, new Date(at + 1000), new Date(at + 1000));
    expect(readLocalRequest("s1", transcript)).toBeUndefined();
    clearLocalRequest("s1");
    expect(existsSync(localRequestFile("s1"))).toBe(false);
  });

  it("shows in the Remote Control Viewer in the prompt line's place, and in the Enter dialog", async () => {
    setOwnSettings("rcViewer");
    mkdirSync(projectDir(cwd), { recursive: true });
    const transcript = join(projectDir(cwd), "s-ask.jsonl");
    const ts = new Date(Date.now() - 60_000);
    writeFileSync(
      transcript,
      [
        { type: "user", uuid: "a-u", timestamp: ts.toISOString(), cwd, message: { role: "user", content: "pick one" } },
        { type: "custom-title", customTitle: "asks a colour", sessionId: "s-ask" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    utimesSync(transcript, ts, ts);
    mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
    writeFileSync(join(claudeDir(), "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s-ask", status: "waiting", cwd }));
    recordLocalRequest({ hook_event_name: "PreToolUse", session_id: "s-ask", tool_name: "AskUserQuestion", tool_input: QUESTION });
    const view = renderInk(<RcViewerApp accounts={{ accounts: [], multiple: false, own: claudeDir() }} />, { columns: 140, rows: 34 });
    await until(() => view.frame().includes("Which colour?"));
    expect(view.frame()).toContain("Claude asks · asks a colour");
    expect(view.frame()).toContain("· Green");
    expect(view.frame()).toContain("Answered in its terminal");
    await view.press("\r");
    await until(() => view.frame().includes("What to do with this session?"));
    // Its terminal is where it is answered: selected, the question below it.
    expect(view.frame()).toMatch(/›\s+Bring its terminal to the front/);
    expect(view.frame().split("\n").filter((l) => l.includes("Which colour?")).length).toBeGreaterThanOrEqual(1);
    view.unmount();
    rmSync(join(claudeDir(), "sessions"), { recursive: true, force: true });
  });
});
