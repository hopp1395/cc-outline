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
import { answersOf, QuestionDialog, questionsOf } from "../src/tui/QuestionDialog.js";
import { SessionsView } from "../src/tui/SessionsView.js";
import { remoteOptions } from "../src/tui/useRemoteControl.js";
import { renderInk, until } from "./helpers/ink.js";

const layout: Layout = { columns: 110, rows: 30, listWidth: 40, previewWidth: 67, bodyHeight: 26 };
const DOWN = "\u001b[B";
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
});

describe("the question dialog", () => {
  const questions = [
    { question: "Colour?", options: [{ label: "Blue" }, { label: "Green" }] },
    { question: "Parts?", multiSelect: true, options: [{ label: "Intro" }, { label: "End" }] },
  ];

  it("asks every question before sending, then sends the choices", async () => {
    const sent: Record<string, string>[] = [];
    const view = renderInk(
      <Box width={layout.columns} height={layout.rows}>
        <QuestionDialog layout={layout} title="Claude asks" questions={questions} onSend={(a) => sent.push(a)} onCancel={() => {}} />
      </Box>,
      layout,
    );
    await until(() => view.frame().includes("Colour?"));
    await view.press(DOWN);
    await view.press(" ");
    await view.press("\r");
    await until(() => view.frame().includes("every question needs an answer"));
    // Green, Other… of the first question, then Intro and End.
    await view.press(DOWN);
    await view.press(DOWN);
    await view.press(" ");
    await view.press(DOWN);
    await view.press(" ");
    await view.press("\r");
    await expect.poll(() => sent).toEqual([{ "Colour?": "Green", "Parts?": "Intro, End" }]);
    view.unmount();
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
    updateSettings({ remoteApi: true, remoteControl: true });
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
    updateSettings({ remoteApi: false, remoteControl: false });
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
