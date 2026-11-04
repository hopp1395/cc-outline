import { Box } from "ink";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSession, remote } from "../src/remote/api.js";
import { SESSIONS_SCOPE } from "../src/remote/credentials.js";
import { setSessionViewer, updateSettings } from "../src/settings.js";
import { App } from "../src/tui/App.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";
import { annotationsOf, answersOf, previewBox, QuestionDialog, questionsOf, tabWindow, type Question } from "../src/tui/QuestionDialog.js";
import { SessionsView } from "../src/tui/SessionsView.js";
import { remoteOptions } from "../src/tui/useRemoteControl.js";
import { renderInk, until } from "./helpers/ink.js";

const layout: Layout = { columns: 110, rows: 30, listWidth: 40, previewWidth: 67, bodyHeight: 26 };
const DOWN = "\u001b[B";
const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
const realFetch = remote.fetch;

const capture = readFileSync(join(import.meta.dirname, "fixtures", "remote-capture.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
/** The events up to the question waiting (#34), and the list entry while it waits. */
const waitingEvents = capture.filter((c) => c.kind === "event" && Number(c.data.sequence_num) <= 34).map((c) => c.data);
const waitingEntry = capture.find((c) => c.kind === "session" && c.data.worker_status === "requires_action")!.data;
const REQUEST = "d8438d2c-ba49-4e52-a166-55c774161b87";

describe("the question of the recorded session", () => {
  it("is named by the list entry while it waits", () => {
    const s = parseSession(waitingEntry)!;
    expect(s.pending).toMatchObject({ requestId: REQUEST, toolName: "AskUserQuestion", toolUseId: "toolu_01LtNgDX5KgXtp7t61wt7Ffy" });
    expect(remoteOptions(s.workerStatus, s.pending)[0]).toMatchObject({ id: "answer", label: "Answer Claude's question", detail: "Welche Farbe magst du?" });
    expect(remoteOptions(s.workerStatus, s.pending)[0]!.disabled).toBeUndefined();
  });

  it("is answered as the app answers it", () => {
    const questions = questionsOf(parseSession(waitingEntry)!.pending!.input);
    expect(answersOf(questions, [{ picked: [0] }])).toEqual({ "Welche Farbe magst du?": "Blau" });
    expect(answersOf(questions, [{ picked: [] }])).toBeUndefined();
    expect(answersOf(questions, [{ picked: [], other: "Türkis" }])).toEqual({ "Welche Farbe magst du?": "Türkis" });
  });

  it("joins several choices and the typed answer", () => {
    const questions = [{ question: "Which?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }];
    expect(answersOf(questions, [{ picked: [0, 1], other: "C" }])).toEqual({ "Which?": "A, B, C" });
  });

  it("adds the chosen preview, or the note typed instead of an option, as Claude Code does", () => {
    const questions = questionsOf({
      questions: [
        { question: "Layout?", options: [{ label: "List", preview: "| 1 |" }, { label: "Grid", preview: 7 }] },
        { question: "Colour?", options: [{ label: "Blue" }] },
      ],
    });
    // A preview that is no text is left out.
    expect(questions[0]!.options).toEqual([{ label: "List", preview: "| 1 |" }, { label: "Grid" }]);
    expect(answersOf(questions, [{ picked: [0] }, { picked: [0] }])).toEqual({ "Layout?": "List", "Colour?": "Blue" });
    expect(annotationsOf(questions, [{ picked: [0] }, { picked: [0] }])).toEqual({ "Layout?": { preview: "| 1 |" } });
    expect(answersOf(questions, [{ picked: [], other: " mine " }, { picked: [0] }])).toEqual({ "Layout?": "(notes only)", "Colour?": "Blue" });
    expect(annotationsOf(questions, [{ picked: [], other: " mine " }, { picked: [0] }])).toEqual({ "Layout?": { notes: "mine" } });
    // An option without a preview, or no question with previews: nothing to add.
    expect(annotationsOf(questions, [{ picked: [1] }, { picked: [0] }])).toBeUndefined();
  });
});

describe("an option's preview", () => {
  it("stands in a box as written, cut to its width and rows", () => {
    const box = previewBox("ab\ncdefgh\n\tx\n4\n5", 8, 5).map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""));
    expect(box).toEqual(["┌──────┐", "│ ab   │", "│ cdef │", "│ … 3  │", "└──────┘"]);
    expect(previewBox(undefined, 20).map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""))).toEqual(["No preview available"]);
  });

  it("goes below the options in a narrow pane, and the dialog grows for it", async () => {
    const narrow: Layout = { columns: 60, rows: 30, listWidth: 20, previewWidth: 40, bodyHeight: 26 };
    const tall = Array.from({ length: 12 }, (_, i) => `row ${i + 1}`).join("\n");
    const questions: Question[] = [{ question: "Layout?", options: [{ label: "List", preview: tall }, { label: "Grid" }] }];
    const view = renderInk(
      <Box width={narrow.columns} height={narrow.rows}>
        <QuestionDialog layout={narrow} title="Claude asks" questions={questions} onSend={() => {}} onCancel={() => {}} />
      </Box>,
      narrow,
    );
    await until(() => view.frame().includes("row 12"));
    const lines = view.frame().split("\n");
    expect(lines.findIndex((l) => l.includes("row 1 "))).toBeGreaterThan(lines.findIndex((l) => l.includes("Note only…")));
    view.unmount();
  });
});

describe("the question dialog", () => {
  const questions = [
    { question: "Colour?", options: [{ label: "Blue" }, { label: "Green" }] },
    { question: "Parts?", multiSelect: true, options: [{ label: "Intro" }, { label: "End" }] },
  ];

  const dialog = (qs: Question[], sent: Record<string, string>[], at = layout) =>
    renderInk(
      <Box width={at.columns} height={at.rows}>
        <QuestionDialog layout={at} title="Claude asks" questions={qs} onSend={(a) => sent.push(a)} onCancel={() => {}} />
      </Box>,
      at,
    );

  it("shows one question at a time, a tab each, and sends from Submit once every question has an answer", async () => {
    const sent: Record<string, string>[] = [];
    const view = dialog(questions, sent);
    await until(() => view.frame().includes("Colour?"));
    expect(view.frame()).toContain("☐ Question 1");
    expect(view.frame()).toContain("✔ Submit");
    expect(view.frame()).not.toContain("Parts?");
    // Green: chosen, and on to the second question.
    await view.press(DOWN);
    await view.press("\r");
    await until(() => view.frame().includes("Parts?"));
    expect(view.frame()).toContain("☒ Question 1");
    expect(view.frame()).not.toContain("Colour?");
    // Several: Space checks, Enter goes on to Submit, which lists the answers.
    await view.press(" ");
    await view.press(DOWN);
    await view.press(" ");
    await view.press("\r");
    await until(() => view.frame().includes("Review your answers"));
    expect(view.frame()).toContain("→ Green");
    expect(view.frame()).toContain("→ Intro, End");
    await view.press("\r");
    await expect.poll(() => sent).toEqual([{ "Colour?": "Green", "Parts?": "Intro, End" }]);
    view.unmount();
  });

  it("switches questions with ←→ and Tab, and goes to the first question without an answer on Submit", async () => {
    const sent: Record<string, string>[] = [];
    const view = dialog(questions, sent);
    await until(() => view.frame().includes("Colour?"));
    await view.press(RIGHT);
    await until(() => view.frame().includes("Parts?"));
    await view.press("\t");
    await until(() => view.frame().includes("Review your answers"));
    expect(view.frame()).toContain("→ no answer yet");
    await view.press("\r");
    await until(() => view.frame().includes("every question needs an answer") && view.frame().includes("Colour?"));
    // A digit chooses at once.
    await view.press("2");
    await until(() => view.frame().includes("Parts?"));
    await view.press(LEFT);
    await until(() => view.frame().includes("Colour?"));
    expect(sent).toEqual([]);
    view.unmount();
  });

  it("wraps long questions, options and descriptions", async () => {
    const narrow: Layout = { ...layout, columns: 40 };
    const long = "Which of these colours should the badge of the account take from now on?";
    const view = dialog([{ question: long, options: [{ label: "A rather long label that cannot fit in one row", description: "And a description that is too long as well" }] }], [], narrow);
    await until(() => view.frame().includes("Which of these"));
    const text = view.frame().replace(/\s+/g, " ");
    expect(text).toContain("from now on?");
    expect(text).toContain("cannot fit");
    expect(text).toContain("in one row");
    expect(text).toContain("too long as well");
    view.unmount();
  });

  it("scrolls the options of a question too tall for the pane", async () => {
    const small: Layout = { ...layout, rows: 14 };
    const many = [{ question: "Pick", options: Array.from({ length: 12 }, (_, i) => ({ label: `Option ${i + 1}` })) }];
    const view = dialog(many, [], small);
    await until(() => view.frame().includes("Option 1"));
    expect(view.frame()).toContain("▼ more");
    expect(view.frame()).not.toContain("Option 12");
    for (let i = 0; i < 11; i++) await view.press(DOWN);
    await until(() => view.frame().includes("Option 12"));
    expect(view.frame()).toContain("▲ more");
    expect(view.frame()).toContain("Pick");
    view.unmount();
  });

  it("keeps the bar's tabs around the active one when they do not fit", () => {
    expect(tabWindow([10, 10, 10], 0, 40)).toEqual({ from: 0, to: 3 });
    expect(tabWindow([10, 10, 10, 10, 10], 4, 30)).toEqual({ from: 3, to: 5 });
    expect(tabWindow([10, 10, 10, 10, 10], 2, 30)).toEqual({ from: 2, to: 4 });
  });

  it("takes a typed answer on Other…", async () => {
    const sent: Record<string, string>[] = [];
    const view = renderInk(
      <Box width={layout.columns} height={layout.rows}>
        <QuestionDialog layout={layout} title="Claude asks" questions={[questions[0]!]} onSend={(a) => sent.push(a)} onCancel={() => {}} />
      </Box>,
      layout,
    );
    await until(() => view.frame().includes("Colour?"));
    await view.press(DOWN);
    await view.press(DOWN);
    await view.press("Red");
    expect(sent).toEqual([]);
    await view.press("\r");
    await expect.poll(() => sent).toEqual([{ "Colour?": "Red" }]);
    view.unmount();
  });
});

describe("answering a remote session", () => {
  let saved: string | undefined;
  let posted: Record<string, unknown>[];
  let answered: boolean;
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
    const dir = (process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-remote-answer-")));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3_600_000, scopes: [SESSIONS_SCOPE] } }));
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", organizationUuid: "org-1" } }));
    posted = [];
    answered = false;
    // The recordings are of a fixed day: Sessions lists all, not only the last 7 days.
    updateSettings({ remoteApi: true, remoteControl: true, sessionsRange: "all" });
    remote.fetch = async (url, init) => {
      if (init.method === "POST") {
        posted.push(JSON.parse(String(init.body)).events[0].payload);
        return new Response("{}", { status: 200 });
      }
      // Answered by the app: the answer follows the question, and the list no longer waits.
      const events = answered ? capture.filter((c) => c.kind === "event" && Number(c.data.sequence_num) <= 36).map((c) => c.data) : waitingEvents;
      const body = url.includes("/events") ? { data: [...events].reverse() } : { data: [answered ? { ...waitingEntry, worker_status: "running", external_metadata: {} } : waitingEntry] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
  });
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = saved;
    remote.fetch = realFetch;
    setSessionViewer(false);
    updateSettings({ remoteApi: false, remoteControl: false, sessionsRange: "7d" });
  });

  const viewer = () => {
    setSessionViewer(true);
    return renderInk(<App cwd={tmpdir()} remoteId={String(waitingEntry.id)} initialMode="chat" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
  };

  it("shows the question in place of the prompt line in the session's viewer and sends the answer as the app does", async () => {
    const app = viewer();
    await until(() => app.frame().includes("Welche Farbe magst du?") && app.frame().includes("Blau"));
    // The chat has the keys at first; Tab hands them to the question.
    await app.press("\t");
    await app.press(" ");
    await app.press("\r");
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: REQUEST,
        response: { behavior: "allow", tool_name: "AskUserQuestion", toolUseID: "toolu_01LtNgDX5KgXtp7t61wt7Ffy", updatedInput: { answers: { "Welche Farbe magst du?": "Blau" } } },
      },
    });
    expect((posted[0]!.response as { response: { updatedInput: { questions: unknown[] } } }).response.updatedInput.questions).toHaveLength(1);
    app.unmount();
  });

  it("cancels the question with Esc, as Esc in the terminal does", async () => {
    const app = viewer();
    await until(() => app.frame().includes("Welche Farbe magst du?") && app.frame().includes("Blau"));
    await app.press("\t");
    await until(() => app.frame().includes("Esc cancel the question"));
    await app.press("\u001b");
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({
      response: { request_id: REQUEST, response: { behavior: "deny", message: "The user declined to answer", toolUseID: "toolu_01LtNgDX5KgXtp7t61wt7Ffy" } },
    });
    app.unmount();
  });

  it("puts the prompt line back when the app answered the question first", async () => {
    const app = viewer();
    await until(() => app.frame().includes("Welche Farbe magst du?") && app.frame().includes("Blau"));
    await app.press("\t");
    answered = true;
    await until(() => app.frame().includes("already answered in another app"));
    expect(app.frame()).not.toContain("Space choose");
    await until(() => app.frame().includes("Enter send"));
    expect(posted).toEqual([]);
    app.unmount();
  });

  it("closes the question in Sessions when the app answered it first", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cco-remote-answer-project-"));
    const view = renderInk(
      <ProgressProvider layout={layout}>
        <SessionsView cwd={cwd} layout={layout} visible active />
      </ProgressProvider>,
      layout,
    );
    await until(() => /⚠ ◈ .*rc-test/.test(view.frame()));
    await view.press("\r");
    await until(() => view.frame().includes("Answer Claude's question"));
    await view.press("\r");
    await until(() => view.frame().includes("Blau"));
    answered = true;
    await expect.poll(() => view.frame(), { timeout: 4000 }).toContain("already answered in another app");
    expect(view.frame()).not.toContain("Space choose");
    view.unmount();
  });

  it("marks the waiting session ⚠ in Sessions and answers it from there", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cco-remote-answer-project-"));
    const view = renderInk(
      <ProgressProvider layout={layout}>
        <SessionsView cwd={cwd} layout={layout} visible active />
      </ProgressProvider>,
      layout,
    );
    await until(() => /⚠ ◈ .*rc-test/.test(view.frame()));
    await view.press("\r");
    await until(() => view.frame().includes("Answer Claude's question"));
    await view.press("\r");
    await until(() => view.frame().includes("Blau"));
    await view.press(DOWN);
    await view.press(" ");
    await view.press("\r");
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({ response: { request_id: REQUEST, response: { updatedInput: { answers: { "Welche Farbe magst du?": "Grün" } } } } });
    view.unmount();
  });
});
