import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { confirmed, remote, sendRename, setTitle } from "../src/remote/api.js";
import { SESSIONS_SCOPE } from "../src/remote/credentials.js";
import { renameAnywhere, renameIo, renamePlan, type RenameSituation } from "../src/sessionRename.js";

const realFetch = remote.fetch;
const realIo = { ...renameIo };
afterAll(() => {
  remote.fetch = realFetch;
});
afterEach(() => {
  Object.assign(renameIo, realIo);
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A config folder with a login as Claude Code keeps it. */
function account(): string {
  const dir = mkdtempSync(join(tmpdir(), "cco-rename-"));
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3_600_000, scopes: [SESSIONS_SCOPE] } }));
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", organizationUuid: "org-1" } }));
  return dir;
}

/** A transcript of a session of this machine. */
function transcript(): { path: string; id: string } {
  const path = join(mkdtempSync(join(tmpdir(), "cco-rename-")), "s1.jsonl");
  writeFileSync(path, JSON.stringify({ type: "user", sessionId: "s1", message: { role: "user", content: "hi" } }) + "\n");
  return { path, id: "s1" };
}
const lastLine = (path: string) => JSON.parse(readFileSync(path, "utf8").trimEnd().split("\n").at(-1)!);

describe("renaming on claude.ai", () => {
  it("sets the title with PUT and tells the worker with rename_session, then finds its answer", async () => {
    const dir = account();
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    let requestId = "";
    remote.fetch = async (url, init) => {
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method: init.method, body });
      if (init.method === "POST") requestId = body.events[0].payload.request_id;
      if (url.includes("/events?")) return json({ data: [{ sequence_num: "2", payload: { type: "control_response", response: { subtype: "success", request_id: requestId } } }] });
      return json({});
    };
    await setTitle("cse_1", "Plan B", dir);
    expect(calls[0]).toEqual({ url: "https://api.anthropic.com/v1/code/sessions/cse_1", method: "PUT", body: { title: "Plan B" } });
    const id = await sendRename("cse_1", "Plan B", dir);
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.body).toMatchObject({ events: [{ payload: { type: "control_request", request_id: id, request: { subtype: "rename_session", title: "Plan B" } } }] });
    expect(await confirmed("cse_1", id, dir)).toBe(true);
    expect(await confirmed("cse_1", "other", dir)).toBe(false);
  });
});

describe("renamePlan", () => {
  const local = { path: "/p/s1.jsonl", id: "s1" };
  const plan = (s: Partial<RenameSituation>) => renamePlan({ control: true, ...s });

  it("goes through claude.ai wherever its Claude Code is connected there and steer remote is on", () => {
    expect(plan({ remote: { id: "cse_1", connected: true } }).way).toBe("claude.ai");
    expect(plan({ local, running: { pid: 1, activity: "busy" }, remote: { id: "cse_1", connected: true } }).way).toBe("claude.ai");
  });

  it("types /rename into a running session of this machine only while it is idle", () => {
    expect(plan({ local, running: { pid: 1, activity: "idle" } })).toMatchObject({ way: "keys", detail: "types /rename into its Claude Code" });
    expect(plan({ local, running: { pid: 1, activity: "busy" } }).disabled).toBe("Claude is working: rename it once it is idle");
    expect(plan({ local, running: { pid: 1, activity: "waiting" } }).disabled).toBe("Claude waits for you in its terminal");
    // Steer remote off: its own Claude Code renames it, and tells claude.ai itself.
    expect(plan({ local, running: { pid: 1, activity: "idle" }, remote: { id: "cse_1", connected: true }, control: false }).way).toBe("keys");
  });

  it("writes the transcript of a session that runs nowhere, saying whether claude.ai follows", () => {
    expect(plan({ local })).toMatchObject({ way: "transcript", detail: "a new title, as /rename gives it" });
    expect(plan({ local, remote: { id: "cse_1", connected: false } }).detail).toBe("a new title, here and on claude.ai");
    expect(plan({ local, remote: { id: "cse_1", connected: false }, control: false }).detail).toContain("claude.ai keeps its own");
  });

  it("renames a remote session whose machine is offline on claude.ai only, and nothing with steer remote off", () => {
    expect(plan({ remote: { id: "cse_1", connected: false } })).toMatchObject({ way: "claude.ai", detail: "on claude.ai; its machine is not connected and keeps its name" });
    expect(plan({ remote: { id: "cse_1", connected: true }, control: false }).disabled).toBe("steer remote is off (Settings of a viewer)");
  });
});

describe("renameAnywhere", () => {
  const record = () => {
    const calls: string[] = [];
    renameIo.setTitle = async (id, title) => void calls.push(`title ${id} ${title}`);
    renameIo.sendRename = async (id, title) => (calls.push(`rename ${id} ${title}`), "r1");
    renameIo.type = async (pid, text) => (calls.push(`type ${pid} ${text}`), { typed: true, message: "typed" });
    renameIo.wait = async () => {};
    return calls;
  };

  it("renames through claude.ai and reports whether its Claude Code confirmed", async () => {
    const calls = record();
    renameIo.confirmed = async () => true;
    expect(await renameAnywhere({ remote: { id: "cse_1", connected: true }, control: true }, "Plan B")).toBe("renamed: Plan B");
    expect(calls).toEqual(["title cse_1 Plan B", "rename cse_1 Plan B"]);
    renameIo.confirmed = async () => false;
    expect(await renameAnywhere({ remote: { id: "cse_1", connected: true }, control: true }, "Plan B")).toBe("renamed on claude.ai: Plan B; its Claude Code did not confirm");
  });

  it("only sets the title of a remote session whose machine is offline", async () => {
    const calls = record();
    expect(await renameAnywhere({ remote: { id: "cse_1", connected: false }, control: true }, "Plan B")).toBe("renamed on claude.ai: Plan B; its machine keeps its name");
    expect(calls).toEqual(["title cse_1 Plan B"]);
  });

  it("types /rename into an idle Claude Code of this machine", async () => {
    const calls = record();
    expect(await renameAnywhere({ local: transcript(), running: { pid: 7, activity: "idle" }, control: true }, "Plan B")).toBe("typed /rename Plan B");
    expect(calls).toEqual(["type 7 /rename Plan B"]);
    renameIo.type = async () => ({ typed: false, message: "no tmux to type it in" });
    await expect(renameAnywhere({ local: transcript(), running: { pid: 7, activity: "idle" }, control: true }, "Plan B")).rejects.toThrow("no tmux to type it in");
  });

  it("writes the transcript of an ended session and sets its title on claude.ai too", async () => {
    const calls = record();
    const local = transcript();
    expect(await renameAnywhere({ local, remote: { id: "cse_1", connected: false }, control: true }, "Plan B")).toBe("renamed: Plan B");
    expect(lastLine(local.path)).toEqual({ type: "custom-title", customTitle: "Plan B", sessionId: "s1" });
    expect(calls).toEqual(["title cse_1 Plan B"]);
    // claude.ai failing leaves the transcript renamed and says so.
    renameIo.setTitle = async () => Promise.reject(new Error("down"));
    expect(await renameAnywhere({ local, remote: { id: "cse_1", connected: false }, control: true }, "Plan C")).toContain("renamed here: Plan C; claude.ai kept its title");
    expect(lastLine(local.path).customTitle).toBe("Plan C");
  });

  it("refuses what renamePlan greys out", async () => {
    record();
    await expect(renameAnywhere({ remote: { id: "cse_1", connected: true }, control: false }, "Plan B")).rejects.toThrow("steer remote is off");
  });
});
