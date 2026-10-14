import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSession, remote, type RemoteEvent } from "../src/remote/api.js";
import { SESSIONS_SCOPE } from "../src/remote/credentials.js";
import { pendingRequests } from "../src/remote/pending.js";
import { setViewLimit, updateSettings } from "../src/settings.js";
import { App, REMOTE_VIEWS } from "../src/tui/App.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";
import { SessionsView } from "../src/tui/SessionsView.js";
import { permissionResponse, remoteOptions, toolInputLines } from "../src/tui/useRemoteControl.js";
import { renderInk, until } from "./helpers/ink.js";

const layout: Layout = { columns: 110, rows: 30, listWidth: 40, previewWidth: 67, bodyHeight: 26 };
const DOWN = "\u001b[B";
const realFetch = remote.fetch;

/**
 * A session recorded in permission mode default, answered in the Claude app: a Bash call allowed (#26 → #29), one
 * denied (#35 → #37), one allowed (#52 → #54).
 */
const capture = readFileSync(join(import.meta.dirname, "fixtures", "remote-permissions.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
const raw = capture.filter((c) => c.kind === "event").map((c) => c.data);
const events: RemoteEvent[] = raw.map((e) => ({ sequence: Number(e.sequence_num), source: e.source as string, payload: e.payload as Record<string, unknown> }));
const upTo = (n: number) => events.filter((e) => e.sequence <= n);
const payload = (n: number) => events.find((e) => e.sequence === n)!.payload as { response: { response: Record<string, unknown> } };
const waiting = capture.filter((c) => c.kind === "session" && c.data.worker_status === "requires_action").map((c) => c.data);

describe("the recorded permissions", () => {
  it("wait from the worker's request until the app's answer", () => {
    expect(pendingRequests(upTo(26))).toMatchObject([{ toolName: "Bash", input: { command: expect.stringContaining("ls -la") } }]);
    expect(pendingRequests(upTo(29))).toEqual([]);
    expect(pendingRequests(upTo(35))).toMatchObject([{ toolName: "Bash", input: { command: "rm /c/workspace/cco-rc/b.txt && ls -la /c/workspace/cco-rc" } }]);
    expect(pendingRequests(events)).toEqual([]);
  });

  it("are named by the list entry while they wait", () => {
    const s = parseSession(waiting.at(-1))!;
    expect(s.pending).toMatchObject({ requestId: "f6f8ec38-4b91-4bf6-bb5b-6c65745d1ca9", toolName: "Bash", displayName: "Bash" });
    expect(remoteOptions(s.workerStatus, s.pending)[0]).toMatchObject({ id: "answer", label: "Allow or deny Bash", detail: expect.stringContaining("$ echo") });
  });

  it("are answered as the app answers them", () => {
    const [allowedReq] = pendingRequests(upTo(26));
    expect(permissionResponse(allowedReq!, true)).toEqual(payload(29).response.response);
    const [deniedReq] = pendingRequests(upTo(35));
    expect(permissionResponse(deniedReq!, false)).toEqual(payload(37).response.response);
  });

  it("show the command to run", () => {
    const [request] = pendingRequests(upTo(35));
    expect(toolInputLines(request!, 80)).toEqual(["$ rm /c/workspace/cco-rc/b.txt && ls -la /c/workspace/cco-rc"]);
    expect(toolInputLines(request!, 20)).toEqual(["$ rm /c/workspace/c…"]);
    expect(toolInputLines({ ...request!, input: { file_path: "C:/x/c.txt", content: "a\nb" } })).toEqual(["C:/x/c.txt", "content: a b"]);
  });
});

describe("answering a permission in a remote viewer", () => {
  let saved: string | undefined;
  let posted: Record<string, unknown>[];
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
    const dir = (process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-remote-permission-")));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3_600_000, scopes: [SESSIONS_SCOPE] } }));
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", organizationUuid: "org-1" } }));
    posted = [];
    updateSettings({ remoteApi: true, remoteControl: true });
    // The deletion waits for its answer.
    remote.fetch = async (url, init) => {
      if (init.method === "POST") {
        posted.push(JSON.parse(String(init.body)).events[0].payload);
        return new Response("{}", { status: 200 });
      }
      const body = url.includes("/events")
        ? { data: raw.filter((e) => Number(e.sequence_num) <= 35).reverse() }
        : { data: [{ id: "cse_perm", title: "rc-perm", worker_status: "requires_action" }] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    setViewLimit(REMOTE_VIEWS);
  });
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = saved;
    remote.fetch = realFetch;
    setViewLimit(undefined);
    updateSettings({ remoteApi: false, remoteControl: false });
  });

  const viewer = () =>
    renderInk(<App cwd={tmpdir()} remoteId="cse_perm" initialMode="chat" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });

  it("asks in place of the prompt line with the command shown, and allows it on Enter", async () => {
    const app = viewer();
    // In place of the prompt line, which has the keys.
    await until(() => app.frame().includes("lösche b.txt") && app.frame().includes("Allow Bash?"));
    expect(app.frame()).toContain("$ rm /c/workspace/cco-rc/b.txt");
    await app.press("\r");
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({
      type: "control_response",
      response: { subtype: "success", request_id: "3a22f9cd-6e64-4fb7-aa09-7abdc34c7331", response: { behavior: "allow", tool_name: "Bash", toolUseID: "toolu_01TpRu3k5NrSMz5LauY1vpoi" } },
    });
    await until(() => app.frame().includes("allowed"));
    app.unmount();
  });

  it("closes the permission window in Sessions once the app allowed it", async () => {
    const entry = (status: string) => ({ ...waiting.at(-1)!, title: "rc-perm", worker_status: status, ...(status === "running" && { external_metadata: {} }) });
    let status = "requires_action";
    remote.fetch = async (url, init) => {
      if (init.method === "POST") return new Response("{}", { status: 200 });
      const body = url.includes("/events") ? { data: [] } : { data: [entry(status)] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    setViewLimit(undefined);
    const cwd = mkdtempSync(join(tmpdir(), "cco-remote-permission-project-"));
    const view = renderInk(
      <ProgressProvider layout={layout}>
        <SessionsView cwd={cwd} layout={layout} visible active />
      </ProgressProvider>,
      layout,
    );
    await until(() => /⚠ ◈ .*rc-perm/.test(view.frame()));
    await view.press("\r");
    await until(() => view.frame().includes("Allow or deny Bash"));
    await view.press("\r");
    await until(() => view.frame().includes("allow Bash?"));
    status = "running";
    await expect.poll(() => view.frame(), { timeout: 4000 }).toContain("already answered in another app");
    expect(view.frame()).not.toContain("allow Bash?");
    view.unmount();
  });

  it("closes it from the session's events even while the list still says it waits", async () => {
    let answered = false;
    remote.fetch = async (url, init) => {
      if (init.method === "POST") return new Response("{}", { status: 200 });
      const events = raw.filter((e) => Number(e.sequence_num) <= (answered ? 54 : 52));
      const body = url.includes("/events") ? { data: [...events].reverse() } : { data: [{ ...waiting.at(-1)!, title: "rc-perm" }] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    setViewLimit(undefined);
    const cwd = mkdtempSync(join(tmpdir(), "cco-remote-permission-project-"));
    const view = renderInk(
      <ProgressProvider layout={layout}>
        <SessionsView cwd={cwd} layout={layout} visible active />
      </ProgressProvider>,
      layout,
    );
    await until(() => /⚠ ◈ .*rc-perm/.test(view.frame()));
    await view.press("\r");
    await until(() => view.frame().includes("Allow or deny Bash"));
    await view.press("\r");
    await until(() => view.frame().includes("allow Bash?"));
    answered = true;
    await expect.poll(() => view.frame()).toContain("already answered in another app");
    view.unmount();
  });

  it("denies it, saying why", async () => {
    const app = viewer();
    // In place of the prompt line, which has the keys.
    await until(() => app.frame().includes("lösche b.txt") && app.frame().includes("Allow Bash?"));
    await app.press(DOWN);
    await app.press(DOWN);
    await app.press("\r");
    await until(() => app.frame().includes("Why? Claude reads it."));
    await app.press("keep it");
    await app.press("\r");
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({ response: { response: { behavior: "deny", message: "keep it" } } });
    app.unmount();
  });
});
