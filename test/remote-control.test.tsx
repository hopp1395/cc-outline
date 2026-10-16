import { Box } from "ink";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remote, sendInterrupt, sendPrompt } from "../src/remote/api.js";
import { SESSIONS_SCOPE } from "../src/remote/credentials.js";
import { setSessionViewer, updateSettings } from "../src/settings.js";
import { projectDir } from "../src/transcript/locate.js";
import { App } from "../src/tui/App.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";
import { PromptDialog, promptRows } from "../src/tui/PromptDialog.js";
import { SessionsView } from "../src/tui/SessionsView.js";
import { remoteOptions } from "../src/tui/useRemoteControl.js";
import { renderInk, until } from "./helpers/ink.js";

const layout: Layout = { columns: 110, rows: 26, listWidth: 40, previewWidth: 67, bodyHeight: 22 };
const DOWN = "\u001b[B";
const realFetch = remote.fetch;

/** The capture's events up to the first answer: one prompt, Claude's answer, the end of the turn. */
const rawEvents = readFileSync(join(import.meta.dirname, "fixtures", "remote-capture.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> })
  .filter((c) => c.kind === "event" && Number(c.data.sequence_num) <= 31)
  .map((c) => c.data);

let saved: string | undefined;
let posted: { url: string; method?: string; body: { events: { payload: Record<string, unknown> }[] } }[];
let status: string;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = (process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-remote-control-")));
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3_600_000, scopes: [SESSIONS_SCOPE] } }));
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", organizationUuid: "org-1" } }));
  posted = [];
  status = "idle";
  remote.fetch = async (url, init) => {
    if (init.method === "POST") {
      posted.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }
    const body = url.includes("/events")
      ? { data: [...rawEvents].reverse() }
      : { data: [{ id: "cse_1", title: "rc-test", worker_status: status, connection_status: "connected", environment_kind: "bridge", last_event_at: new Date().toISOString() }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
  remote.fetch = realFetch;
  setSessionViewer(false);
});

describe("writing to a remote session", () => {
  it("posts a prompt as the app does: a user event with a uuid", async () => {
    await sendPrompt("cse_1", "run the tests");
    expect(posted[0]!.url).toBe("https://api.anthropic.com/v1/code/sessions/cse_1/events");
    const [event] = posted[0]!.body.events;
    expect(event!.payload).toMatchObject({ type: "user", message: { role: "user", content: "run the tests" } });
    expect(event!.payload.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("interrupts with a control request", async () => {
    await sendInterrupt("cse_1");
    expect(posted[0]!.body.events[0]!.payload).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
  });

  it("offers what fits what the session does", () => {
    expect(remoteOptions("idle").map((o) => o.id)).toEqual(["prompt"]);
    expect(remoteOptions("running").map((o) => o.id)).toEqual(["interrupt", "prompt"]);
    const waiting = remoteOptions("requires_action");
    expect(waiting[0]).toMatchObject({ id: "answer", disabled: expect.any(String) });
  });
});

describe("the prompt dialog", () => {
  it("cuts the text into rows by line break and width, and finds the cursor", () => {
    const { rows, row, column } = promptRows("abcdef\nxy", 8, 4);
    expect(rows.map((r) => r.text)).toEqual(["abcd", "ef", "xy"]);
    expect([row, column]).toEqual([2, 1]);
  });

  it("takes several lines, sends on Enter and keeps an unsent draft", async () => {
    const sent: string[] = [];
    let closed = 0;
    const open = () =>
      renderInk(
        <Box width={layout.columns} height={layout.rows}>
          <PromptDialog layout={layout} title="Send a prompt" lines={[]} draftKey="s" onSend={(t) => sent.push(t)} onCancel={() => closed++} />
        </Box>,
        layout,
      );
    const first = open();
    await first.press("hi");
    await first.press("\n");
    await first.press("there");
    await first.press("\u001b");
    await expect.poll(() => closed).toBe(1);
    first.unmount();
    const second = open();
    await until(() => second.frame().includes("there"));
    await second.press("\r");
    await expect.poll(() => sent).toEqual(["hi\nthere"]);
    second.unmount();
  });
});

describe("steer remote in the viewers", () => {
  const viewer = () => {
    setSessionViewer(true);
    return renderInk(<App cwd={tmpdir()} remoteId="cse_1" initialMode="chat" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
  };

  it("types into the prompt line below the chat once Tab gave it the keys, and sends on Enter", async () => {
    updateSettings({ remoteApi: true, remoteControl: true });
    const app = viewer();
    await until(() => app.frame().includes("lege die datei a.txt") && app.frame().includes("Tab write a prompt"));
    await app.press("\t");
    await until(() => app.frame().includes("Enter send"));
    // The prompt line is the last thing on the screen, below the chat.
    const rows = app.frame().split("\n");
    expect(rows.findIndex((r) => r.includes("Enter send"))).toBeGreaterThan(rows.findIndex((r) => r.includes("lege die datei a.txt")));
    // Keys of the chat (q quits, t tools) are text here.
    await app.press("quit it");
    await until(() => app.frame().includes("› quit it"));
    await app.press("\n");
    await app.press("and go on");
    await app.press("\r");
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]!.body.events[0]!.payload.message).toEqual({ role: "user", content: "quit it\nand go on" });
    await until(() => !app.frame().includes("and go on"));
    app.unmount();
  });

  it("starts with the keys in the chat, hands them to the prompt line with i and back with Esc", async () => {
    updateSettings({ remoteApi: true, remoteControl: true });
    const app = viewer();
    await until(() => app.frame().includes("Tab write a prompt"));
    await app.press("i");
    await until(() => app.frame().includes("Enter send"));
    await app.press("\u001b");
    await until(() => app.frame().includes("Tab write a prompt"));
    await app.press("\t");
    await until(() => app.frame().includes("Enter send"));
    app.unmount();
  });

  it("leaves the prompt line in the chat: its settings (6) take Tab as a view switch", async () => {
    updateSettings({ remoteApi: true, remoteControl: true });
    const app = viewer();
    await until(() => app.frame().includes("Tab write a prompt"));
    await app.press("6");
    await until(() => app.frame().includes("confirm quit"));
    expect(app.frame()).not.toContain("Tab write a prompt");
    await app.press("\t");
    await until(() => app.frame().includes("Tab write a prompt"));
    await app.press("\t");
    await until(() => app.frame().includes("Enter send"));
    app.unmount();
  });

  it("stops Claude with Esc while it works", async () => {
    updateSettings({ remoteApi: true, remoteControl: true });
    status = "running";
    const app = viewer();
    await until(() => app.frame().includes("Tab write a prompt"));
    await app.press("\t");
    await until(() => app.frame().includes("Esc stop Claude"));
    await app.press("\u001b");
    await expect.poll(() => posted[0]?.body.events[0]?.payload.type).toBe("control_request");
    expect(posted[0]!.body.events[0]!.payload).toMatchObject({ request: { subtype: "interrupt" } });
    app.unmount();
  });

  it("says why nothing can be sent without the setting, and keeps the keys in the chat", async () => {
    updateSettings({ remoteApi: true, remoteControl: false });
    const app = viewer();
    await until(() => app.frame().includes("lege die datei a.txt") && app.frame().includes("steer remote is off"));
    expect(app.frame()).not.toContain("Tab write a prompt");
    await app.press("\t");
    await until(() => app.frame().includes("confirm quit"));
    expect(app.frame()).not.toContain("Enter send");
    app.unmount();
  });

  it("puts sending a prompt first in the Sessions dialog of an idle remote session", async () => {
    updateSettings({ remoteApi: true, remoteControl: true });
    const cwd = mkdtempSync(join(tmpdir(), "cco-remote-control-project-"));
    mkdirSync(projectDir(cwd), { recursive: true });
    const file = join(projectDir(cwd), "mine.jsonl");
    writeFileSync(file, JSON.stringify({ type: "user", uuid: "u", timestamp: new Date(Date.now() - 3_600_000).toISOString(), cwd, message: { role: "user", content: "older work" } }) + "\n");
    utimesSync(file, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const view = renderInk(<ProgressProvider layout={layout}><SessionsView cwd={cwd} layout={layout} visible active /></ProgressProvider>, layout);
    await until(() => view.frame().includes("rc-test"));
    await view.press("\r");
    await until(() => view.frame().includes("Send a prompt"));
    const lines = view.frame().split("\n");
    expect(lines.findIndex((l) => l.includes("Send a prompt"))).toBeLessThan(lines.findIndex((l) => l.includes("Open it in a session viewer")));
    await view.press(DOWN);
    await view.press(DOWN);
    view.unmount();
  });
});
