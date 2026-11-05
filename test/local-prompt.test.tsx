import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordLocalRequest } from "../src/localRequest.js";
import { proc } from "../src/proc.js";
import { questionAnswerSteps } from "../src/switchSession.js";
import { TIMING } from "../src/timing.js";
import { setSessionViewer } from "../src/settings.js";
import { claudeDir, projectDir } from "../src/transcript/locate.js";
import { App } from "../src/tui/App.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";
import { localBlocked, terminalOf } from "../src/tui/useLocalPrompt.js";
import { renderInk, tick, until } from "./helpers/ink.js";

const layout: Layout = { columns: 110, rows: 24, listWidth: 40, previewWidth: 67, bodyHeight: 20 };

describe("why a prompt cannot be typed into a session of this machine", () => {
  const idle = { pid: 1, activity: "idle" as const };
  it("names what stands in the way, or nothing", () => {
    expect(localBlocked(undefined, "wt", "win32")).toBe("not running: Enter in Sessions continues it");
    expect(localBlocked({ ...idle, kind: "bg", jobId: "j1" }, "wt", "win32")).toBe("background session: claude attach j1");
    expect(localBlocked(idle, undefined, "darwin")).toBe("no tmux or WezTerm: cco cannot type into it");
    expect(localBlocked(idle, "wezterm", "darwin")).toBeUndefined();
    expect(localBlocked({ ...idle, activity: "waiting" }, "tmux", "linux")).toBe("Claude waits for you in its terminal");
    expect(localBlocked(idle, "tmux", "linux")).toBeUndefined();
    expect(localBlocked(idle, "wt", "win32")).toBeUndefined();
  });

  it("brings its terminal to the front while Claude waits there, unless claude.ai answers or it cannot", () => {
    const front = () => {};
    const waiting = { ...idle, activity: "waiting" as const };
    expect(terminalOf(waiting, front, false, true)).toEqual({ front, waits: true });
    expect(terminalOf(idle, front, false, true)).toEqual({ front, waits: false });
    // Connected to claude.ai (⇄): what it waits for is answered there.
    expect(terminalOf(waiting, front, true, true)?.waits).toBe(false);
    expect(terminalOf(waiting, front, false, false)).toEqual({ why: "no Windows Terminal, WezTerm or tmux", waits: true });
    expect(terminalOf({ ...waiting, kind: "bg" }, front, false, true)).toEqual({ why: "a background session has no tab", waits: true });
    expect(terminalOf(undefined, front)).toBeUndefined();
  });
});

describe("the keys that answer Claude Code's question dialog", () => {
  // The pauses as tried on Claude Code, not the tests' shortened ones.
  const shortened = TIMING.questionKeys;
  beforeAll(() => void (TIMING.questionKeys = 1));
  afterAll(() => void (TIMING.questionKeys = shortened));
  const options = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `o${i}` }));
  const DOWN = ["\u0000", 0x28, 0, 150];
  it("picks one answer by its digit, a typed one on the row after the options, and sends a single one at once", () => {
    expect(questionAnswerSteps([{ options: options(3) }], [{ picked: [1] }]).map((s) => s[0])).toEqual(["2"]);
    expect(questionAnswerSteps([{ options: options(3) }], [{ picked: [], other: "Grün,\n hell" }]).map((s) => s[0])).toEqual(["4", "Grün, hell", "\r"]);
  });
  it("checks several by their digits, goes down to Submit, and confirms the review", () => {
    const steps = questionAnswerSteps([{ options: options(2) }, { multiSelect: true, options: options(3) }], [{ picked: [0] }, { picked: [0, 2] }]);
    expect(steps).toEqual([["1", 0, 0, 300], ["1", 0, 0, 200], ["3", 0, 0, 200], DOWN, DOWN, DOWN, DOWN, ["\r", 13, 0, 400], ["1", 0, 0, 0]]);
    // A typed answer: its row checked, the cursor down to it, the text, then down once more to Submit.
    const typed = questionAnswerSteps([{ multiSelect: true, options: options(2) }], [{ picked: [1], other: "Mango" }]);
    expect(typed).toEqual([["2", 0, 0, 200], ["3", 0, 0, 200], DOWN, DOWN, ["Mango", 0, 0, 300], DOWN, ["\r", 13, 0, 400], ["1", 0, 0, 0]]);
  });
  it("picks an option with a preview by its digit and Enter, and types a text as a note without an option", () => {
    const previewed = [{ label: "List", preview: "+--+\n|  |" }, { label: "Grid" }];
    // The digit only moves the cursor there; Enter picks and goes on (a single question: sent at once).
    expect(questionAnswerSteps([{ options: previewed }], [{ picked: [1] }])).toEqual([["2", 0, 0, 200], ["\r", 13, 0, 400]]);
    // No "Type something": n opens the note, Enter sends it (Claude gets "(no option selected) notes: …").
    expect(questionAnswerSteps([{ options: previewed }], [{ picked: [], other: "a\nnote" }])).toEqual([["n", 0, 0, 300], ["a note", 0, 0, 300], ["\r", 13, 0, 400]]);
    // A plain question after one with previews keeps its digit; the review follows.
    expect(questionAnswerSteps([{ options: previewed }, { options: options(2) }], [{ picked: [0] }, { picked: [1] }]).map((s) => s[0])).toEqual(["1", "\r", "2", "1"]);
    // Previews of a question with several answers do not change its keys, nor an empty one.
    expect(questionAnswerSteps([{ multiSelect: true, options: previewed }], [{ picked: [0] }]).map((s) => s[0])).toEqual(["1", DOWN[0], DOWN[0], DOWN[0], "\r", "1"]);
    expect(questionAnswerSteps([{ options: [{ label: "A", preview: " " }, { label: "B" }] }], [{ picked: [1] }]).map((s) => s[0])).toEqual(["2"]);
  });
});

describe("the prompt line of a viewer of a session of this machine", () => {
  // tmux types: every send-keys is recorded, the pane of this process is %1; the panes switched to as well.
  const keys: string[][] = [];
  const switched: string[] = [];
  const real = { ...proc };
  const saved = { ...process.env };
  beforeAll(() => {
    proc.execFile = ((cmd: string, args: string[], _opts: object, done: (err: Error | null, stdout: string) => void) => {
      if (cmd === "tmux" && args[0] === "list-panes") done(null, `${process.pid} %1\n`);
      else if (cmd === "tmux" && args[0] === "send-keys") {
        keys.push(args.slice(3));
        done(null, "");
      } else if (cmd === "tmux" && args[0] === "switch-client") {
        switched.push(args[2]!);
        done(null, "");
      } else done(new Error("not faked"), "");
    }) as never;
  });
  afterAll(() => Object.assign(proc, real));
  let cwd: string;
  beforeEach(() => {
    keys.length = 0;
    switched.length = 0;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-local-prompt-"));
    process.env.TMUX = "/tmp/tmux";
    process.env.TMUX_PANE = "%9";
    cwd = join(tmpdir(), "cco-local-prompt-project");
    mkdirSync(projectDir(cwd), { recursive: true });
    const prompt = { type: "user", uuid: "u1", timestamp: new Date().toISOString(), cwd, message: { role: "user", content: "watch me work" } };
    writeFileSync(join(projectDir(cwd), "s1.jsonl"), JSON.stringify(prompt) + "\n");
    setSessionViewer(true);
  });
  afterEach(() => {
    setSessionViewer(false);
    process.env = { ...saved };
  });

  const runs = (status: string) => {
    mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
    writeFileSync(join(claudeDir(), "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s1", status, statusUpdatedAt: Date.now() }));
  };
  const viewer = () =>
    renderInk(<App cwd={cwd} sessionId="s1" initialMode="chat" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });

  it("types a prompt into the Claude Code that runs it, a line break as \\ and Enter", async () => {
    runs("idle");
    const app = viewer();
    await until(() => app.frame().includes("Tab write a prompt"));
    await app.press("\t");
    await until(() => app.frame().includes("Enter send"));
    await app.press("one");
    await app.press("\n");
    await app.press("two");
    await app.press("\r");
    await expect.poll(() => keys.length, { timeout: 3000 }).toBe(4);
    expect(keys).toEqual([["-l", "one\\"], ["Enter"], ["-l", "two"], ["Enter"]]);
    // Nothing cleared what was typed there before.
    expect(keys.flat()).not.toContain("C-l");
    await until(() => !app.frame().includes("two"));
    app.unmount();
  });

  it("stops Claude with Esc while it works", async () => {
    runs("busy");
    const app = viewer();
    await until(() => app.frame().includes("Tab write a prompt"));
    await app.press("\t");
    await until(() => app.frame().includes("Esc stop Claude"));
    await app.press("\u001b");
    await expect.poll(() => keys).toEqual([["Escape"]]);
    app.unmount();
  });

  it("brings its terminal to the front with Enter while Claude waits there for a dialog its hooks do not see", async () => {
    runs("waiting");
    const app = viewer();
    await until(() => app.frame().includes("Claude waits for you in its terminal") && app.frame().includes("Tab bring its terminal to the front"));
    await app.press("\t");
    await until(() => app.frame().includes("Enter bring its terminal to the front"));
    await app.press("\r");
    await expect.poll(() => switched).toEqual(["%1"]);
    // Nothing typed into the dialog; Esc gives the keys back to the chat.
    expect(keys).toEqual([]);
    await app.press("\u001b");
    await until(() => app.frame().includes("Tab bring its terminal to the front"));
    expect(keys).toEqual([]);
    app.unmount();
  });

  it("does the same for a permission its hooks recorded, shown above", async () => {
    runs("waiting");
    recordLocalRequest({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" } });
    const app = viewer();
    await until(() => app.frame().includes("Allow Bash?") && app.frame().includes("Answered in its terminal"));
    await app.press("\t");
    await until(() => app.frame().includes("Enter bring its terminal to the front"));
    await app.press("\r");
    await expect.poll(() => switched).toEqual(["%1"]);
    expect(keys).toEqual([]);
    app.unmount();
  });

  it("says why its terminal cannot come to the front, and keeps the keys in the chat", async () => {
    mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
    writeFileSync(join(claudeDir(), "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s1", status: "waiting", kind: "bg", jobId: "j1" }));
    const app = viewer();
    await until(() => app.frame().includes("Claude waits for you in its terminal · a background session has no tab: claude attach j1"));
    expect(app.frame()).not.toContain("bring its terminal to the front");
    await app.press("\t");
    await until(() => app.frame().includes("confirm quit"));
    expect(keys).toEqual([]);
    expect(switched).toEqual([]);
    app.unmount();
  });

  it("answers the question Claude waits for in its terminal, typed into its dialog", async () => {
    runs("waiting");
    const questions = [
      { question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Blue" }, { label: "Green" }] },
      { question: "Which fruit?", header: "Fruit", multiSelect: true, options: [{ label: "Apple" }, { label: "Kiwi" }] },
    ];
    recordLocalRequest({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "AskUserQuestion", tool_input: { questions } });
    const app = viewer();
    await until(() => app.frame().includes("Which colour?") && app.frame().includes("Claude asks"));
    expect(app.frame()).not.toContain("Answered in its terminal");
    await app.press("\t");
    await app.press("2");
    await until(() => app.frame().includes("Which fruit?"));
    await app.press(" ");
    await app.press("\r");
    await until(() => app.frame().includes("Submit"));
    await app.press("\r");
    await expect.poll(() => keys, { timeout: 3000 }).toEqual([["-l", "2"], ["-l", "1"], ["Down"], ["Down"], ["Down"], ["Enter"], ["-l", "1"]]);
    // Answered once: what it asked shows read-only until Claude Code writes the answer (here it never does, so a
    // moment later the line says the answer did not arrive).
    await until(() => app.frame().includes("Answered in its terminal") || app.frame().includes("The answer did not arrive"));
    expect(app.frame()).toMatch(/Answered in its terminal|The answer did not arrive/);
    app.unmount();
  });

  const previewQuestion = () =>
    recordLocalRequest({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Where does the folder go?",
            header: "Position",
            multiSelect: false,
            options: [
              { label: "Before the time", preview: "● Fix login bug  cc-outline 5m" },
              { label: "After the time", preview: "● Fix login bug 5m  cc-outline" },
            ],
          },
        ],
      },
    });

  it("shows the selected option's preview, picks it with its digit and Enter, and says when Claude still asks", async () => {
    runs("waiting");
    previewQuestion();
    const app = viewer();
    await until(() => app.frame().includes("Note only…"));
    // Beside the options, the preview of the selected one; its free text is a note.
    expect(app.frame()).toContain("Fix login bug  cc-outline 5m");
    expect(app.frame()).toContain("Note only…");
    await app.press("\t");
    await app.press("\u001b[B");
    await until(() => app.frame().includes("Fix login bug 5m  cc-outline"));
    await app.press("2");
    await expect.poll(() => keys, { timeout: 3000 }).toEqual([["-l", "2"], ["Enter"]]);
    // Claude still waits for the same question: the keys did not arrive.
    await until(() => app.frame().includes("The answer did not arrive"));
    expect(app.frame()).toContain("The answer did not arrive");
    app.unmount();
  });

  it("types the answer again with r where Claude still asks after the keys", async () => {
    runs("waiting");
    previewQuestion();
    const app = viewer();
    await until(() => app.frame().includes("Note only…"));
    await app.press("\t");
    await app.press("1");
    await until(() => app.frame().includes("The answer did not arrive"));
    await app.press("\t");
    await until(() => app.frame().includes("r type the answer again"));
    await app.press("r");
    await expect.poll(() => keys, { timeout: 3000 }).toEqual([["-l", "1"], ["Enter"], ["-l", "1"], ["Enter"]]);
    app.unmount();
  });

  it("cancels the question with Esc, as Esc in its terminal does, and gives the keys back with Tab", async () => {
    runs("waiting");
    previewQuestion();
    const app = viewer();
    await until(() => app.frame().includes("Note only…"));
    expect(app.frame()).toContain("Esc cancel the question");
    // Tab gives the keys to the question and back: Esc in the chat then types nothing.
    await app.press("\t");
    await app.press("\t");
    await app.press("\u001b");
    await tick(100);
    expect(keys).toEqual([]);
    await app.press("\t");
    await app.press("\u001b");
    await expect.poll(() => keys).toEqual([["Escape"]]);
    // Still asked: Esc again where it says so.
    await until(() => app.frame().includes("Not cancelled: Claude still asks"));
    await app.press("\t");
    await app.press("\u001b");
    await expect.poll(() => keys).toEqual([["Escape"], ["Escape"]]);
    app.unmount();
  });

  it("says that a session that runs nowhere cannot be written to", async () => {
    const app = viewer();
    await until(() => app.frame().includes("not running: Enter in Sessions continues it"));
    expect(app.frame()).not.toContain("Tab write a prompt");
    app.unmount();
  });
});
