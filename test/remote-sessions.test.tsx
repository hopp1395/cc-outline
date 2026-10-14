import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { remote } from "../src/remote/api.js";
import { SESSIONS_SCOPE } from "../src/remote/credentials.js";
import { readSettings, updateSettings } from "../src/settings.js";
import { projectDir } from "../src/transcript/locate.js";
import type { Layout } from "../src/tui/layout.js";
import { SessionsView } from "../src/tui/SessionsView.js";
import { renderInk, until } from "./helpers/ink.js";

const layout: Layout = { columns: 120, rows: 26, listWidth: 40, previewWidth: 77, bodyHeight: 22 };
const DOWN = "\u001b[B";
const RIGHT = "\u001b[C";

const realFetch = remote.fetch;
afterAll(() => {
  remote.fetch = realFetch;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const LOCAL_ID = "0a1b2c3d-1111-2222-3333-444455556666";

describe("remote sessions in Sessions", () => {
  let saved: string | undefined;
  let cwd: string;
  let listed: object[];
  let status = 200;
  let requests: string[];
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
    const dir = (process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-remote-view-")));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3_600_000, scopes: [SESSIONS_SCOPE] } }));
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", organizationUuid: "org-1" } }));
    cwd = mkdtempSync(join(tmpdir(), "cco-remote-view-project-"));
    status = 200;
    requests = [];
    listed = [
      { id: "cse_far", title: "Build on the server", worker_status: "running", connection_status: "connected", environment_kind: "bridge", created_at: new Date(Date.now() - 600_000).toISOString(), last_event_at: new Date(Date.now() - 60_000).toISOString(), user_message_count: 1 },
    ];
    remote.fetch = async (url) => {
      requests.push(url);
      if (status !== 200) return json({ type: "error" }, status);
      if (url.includes("/events"))
        return json({ data: [{ sequence_num: "1", payload: { type: "user", message: { role: "user", content: "fix the failing build" } } }] });
      return json({ data: listed });
    };
  });
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = saved;
  });

  function local(id: string, text: string, minutes: number) {
    mkdirSync(projectDir(cwd), { recursive: true });
    const ts = new Date(Date.now() - minutes * 60_000).toISOString();
    const file = join(projectDir(cwd), `${id}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "user", uuid: `${id}-u`, timestamp: ts, cwd, message: { role: "user", content: text } }) + "\n");
    utimesSync(file, new Date(ts), new Date(ts));
  }

  it("asks claude.ai only when the setting is on", async () => {
    local("mine", "my local work", 30);
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout);
    await until(() => view.frame().includes("my local work"));
    await new Promise((r) => setTimeout(r, 100));
    expect(requests).toEqual([]);
    expect(view.frame()).not.toContain("Build on the server");
    view.unmount();
  });

  it("lists a remote session marked ◈ and reads its prompts once it is selected", async () => {
    updateSettings({ remoteApi: true });
    local("mine", "my local work", 30);
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout);
    await until(() => view.frame().includes("Build on the server"));
    expect(view.frame()).toMatch(/◈ .*Build on the server/);
    // The newest is selected: the header says what claude.ai reports, then the events fill in the prompts.
    expect(view.frame()).toContain("◈ remote · working · connected");
    await until(() => view.frame().includes("fix the failing build"));
    expect(view.frame()).toContain("https://claude.ai/code/cse_far");
    expect(requests.some((r) => r.includes("/v1/code/sessions/cse_far/events"))).toBe(true);
    view.unmount();
  });

  it("shows one of this machine's sessions as connected instead of listing it twice", async () => {
    updateSettings({ remoteApi: true });
    local(LOCAL_ID, "work on this machine", 10);
    listed = [{ id: "cse_same", title: "Same session", external_metadata: { session_id: LOCAL_ID }, last_event_at: new Date().toISOString() }];
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout);
    await until(() => /⇄ .*work on this machine/.test(view.frame()));
    expect(view.frame()).not.toContain("Same session");
    view.unmount();
  });

  it("says why the list is empty when claude.ai refuses the login", async () => {
    updateSettings({ remoteApi: true });
    status = 401;
    local("mine", "my local work", 30);
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout);
    await until(() => view.frame().includes("claude.ai refused the login"));
    expect(view.frame()).toContain("my local work");
    view.unmount();
  });

  it("filters them in the dialog, which has the remote group only with the setting on", async () => {
    local("mine", "my local work", 30);
    const without = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout);
    await until(() => without.frame().includes("my local work"));
    await without.press("a");
    await until(() => without.frame().includes("Show sessions"));
    expect(without.frame()).not.toContain("Remote Control, claude.ai");
    without.unmount();

    updateSettings({ remoteApi: true });
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout);
    await until(() => view.frame().includes("Build on the server"));
    await view.press("a");
    await until(() => view.frame().includes("Remote Control, claude.ai"));
    // Folders (2 rows), background, then remote: step to it and choose `only`.
    for (let i = 0; i < 3; i++) await view.press(DOWN);
    await view.press(RIGHT);
    await view.press("\r");
    await expect.poll(() => readSettings().sessionsRemote).toBe("only");
    await until(() => !view.frame().includes("my local work"));
    expect(view.frame()).toContain("Build on the server");
    view.unmount();
  });

  it("offers the address on Enter and cannot delete it", async () => {
    updateSettings({ remoteApi: true });
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout);
    await until(() => view.frame().includes("Build on the server"));
    await view.press("d");
    await until(() => view.frame().includes("a remote session lives on claude.ai"));
    await view.press("\r");
    await until(() => view.frame().includes("Copy its address"));
    expect(view.frame()).toContain("https://claude.ai/code/cse_far");
    view.unmount();
  });
});
