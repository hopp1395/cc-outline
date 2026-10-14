import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EVENT_LIMIT, listEvents, listSessions, parseSession, remote } from "../src/remote/api.js";
import { readLogin, RemoteError, SESSIONS_SCOPE } from "../src/remote/credentials.js";
import { describeRemoteError, RemoteSessions, remoteSummary, remoteUrl } from "../src/remote/index.js";
import { toTranscript } from "../src/remote/toTranscript.js";
import { diagnoseGroup } from "../src/doctor.js";
import { passesFilter, type SessionFilter } from "../src/sessionFilter.js";
import { writeJson } from "../src/transcript/locate.js";
import { DEFAULT_SETTINGS, readSettings, settingsFile, updateSettings } from "../src/settings.js";

const realFetch = remote.fetch;
afterAll(() => {
  remote.fetch = realFetch;
});

const TOKEN = "secret-token-value";

/** A config folder with a login (and the account's organisation) as Claude Code keeps them. */
function account(login: object | null = { accessToken: TOKEN, expiresAt: Date.now() + 3_600_000, scopes: [SESSIONS_SCOPE] }, org: string | undefined = "org-1"): string {
  const dir = mkdtempSync(join(tmpdir(), "cco-remote-"));
  if (login) writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: login }));
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", ...(org && { organizationUuid: org }) } }));
  return dir;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the login", () => {
  it("is read from the config folder, with the organisation", () => {
    expect(readLogin(account())).toEqual({ token: TOKEN, org: "org-1" });
  });

  it.each([
    ["no login file", () => account(null), "no-login"],
    ["an expired token", () => account({ accessToken: TOKEN, expiresAt: Date.now() - 1, scopes: [SESSIONS_SCOPE] }), "expired"],
    ["a login without the sessions scope", () => account({ accessToken: TOKEN, expiresAt: Date.now() + 1000, scopes: ["user:inference"] }), "no-scope"],
  ])("fails for %s", (_name, make, kind) => {
    expect(() => readLogin(make())).toThrowError(expect.objectContaining({ kind }));
  });

  it("names a missing organisation", () => {
    const dir = account({ accessToken: TOKEN, scopes: [SESSIONS_SCOPE] }, "");
    expect(() => readLogin(dir)).toThrowError(expect.objectContaining({ kind: "no-org" }));
  });

  it("never puts the token in an error", () => {
    for (const make of [() => account({ accessToken: TOKEN, expiresAt: 1, scopes: [] }), () => account({ accessToken: TOKEN, scopes: [] })]) {
      try {
        readLogin(make());
      } catch (err) {
        expect((err as Error).message).not.toContain(TOKEN);
      }
    }
  });
});

describe("the API", () => {
  let dir: string;
  let calls: { url: string; init: RequestInit }[];
  beforeEach(() => {
    dir = account();
    calls = [];
  });
  const answer = (respond: (url: string) => Response) => {
    remote.fetch = async (url, init) => {
      calls.push({ url, init });
      return respond(url);
    };
  };

  it("lists the sessions with the login's headers, reading only", async () => {
    answer(() => json({ data: [{ id: "cse_1", title: "Work", worker_status: "running", connection_status: "connected", environment_kind: "bridge", last_event_at: "2026-10-14T10:00:00Z", user_message_count: 3 }, { nothing: true }] }));
    const sessions = await listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "cse_1", title: "Work", workerStatus: "running", environmentKind: "bridge", userMessageCount: 3 });
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/code/sessions");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["x-organization-uuid"]).toBe("org-1");
  });

  it("finds ids of other sessions in a listed one", () => {
    const local = "0a1b2c3d-1111-2222-3333-444455556666";
    expect(parseSession({ id: "cse_1", external_metadata: { session_id: local } })?.refs).toEqual([local]);
  });

  it("reads the events oldest first, once each", async () => {
    answer(() => json({ data: [{ sequence_num: "3", payload: { type: "assistant" } }, { sequence_num: "2", payload: { type: "user" } }, { sequence_num: "2", payload: { type: "user" } }, { sequence_num: "1", payload: { type: "system" } }, { sequence_num: "x", payload: {} }] }));
    const { events, truncated } = await listEvents("cse_1", dir);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(truncated).toBe(false);
    expect(calls[0]!.url).toContain(`/v1/code/sessions/cse_1/events?limit=${EVENT_LIMIT}`);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate-limit"],
    [503, "server"],
    [418, "format"],
  ])("maps status %i to %s", async (status, kind) => {
    answer(() => json({ type: "error" }, status));
    await expect(listSessions(dir)).rejects.toMatchObject({ kind });
  });

  it("rejects a list in another shape and tells a certificate problem from a lost connection", async () => {
    answer(() => json({ sessions: [] }));
    await expect(listSessions(dir)).rejects.toMatchObject({ kind: "format" });
    remote.fetch = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" } });
    };
    await expect(listSessions(dir)).rejects.toMatchObject({ kind: "tls" });
    remote.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(listSessions(dir)).rejects.toMatchObject({ kind: "offline" });
  });

  it("describes failures for the top bar", () => {
    expect(describeRemoteError(new RemoteError("expired", "the login has expired"))).toBe("the login has expired");
    expect(describeRemoteError(new Error("boom"))).toContain("boom");
  });
});

describe("the events as a transcript", () => {
  const event = (sequence: number, payload: Record<string, unknown>) => ({ sequence, payload, createdAt: `2026-10-14T10:0${sequence}:00Z` });

  it("turns messages into lines, a result into the end of the turn, and counts the rest", () => {
    const { lines, unknown } = toTranscript([
      event(1, { type: "system", subtype: "init" }),
      event(2, { type: "user", message: { role: "user", content: "hello" } }),
      event(3, { type: "stream_event" }),
      event(4, { type: "assistant", message: { role: "assistant", id: "m1", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" } }),
      event(5, { type: "result", duration_ms: 1500 }),
      event(6, { type: "control_request" }),
      event(7, { type: "stream_event" }),
    ]);
    const entries = lines.map((l) => JSON.parse(l));
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "system"]);
    expect(entries[0]).toMatchObject({ uuid: "remote-2", timestamp: "2026-10-14T10:02:00Z", isSidechain: false });
    expect(entries[2]).toMatchObject({ subtype: "turn_duration", durationMs: 1500 });
    expect(unknown).toEqual({ stream_event: 2, control_request: 1 });
  });
});

describe("remote sessions as summaries", () => {
  it("shows what the list holds, then the prompts of the events", async () => {
    const dir = account();
    remote.fetch = async (url) =>
      url.includes("/events")
        ? json({
            data: [
              { sequence_num: "2", payload: { type: "assistant", message: { role: "assistant", id: "m1", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } } },
              { sequence_num: "1", payload: { type: "user", message: { role: "user", content: "fix the build" } } },
            ],
          })
        : json({ data: [{ id: "cse_9", title: "Build", created_at: "2026-10-14T09:00:00Z", last_event_at: "2026-10-14T09:30:00Z", user_message_count: 1 }] });
    const api = new RemoteSessions(dir);
    const [listed] = await api.list();
    expect(listed).toMatchObject({ id: "cse_9", title: "Build", modified: "2026-10-14T09:30:00Z", prompts: [], remote: { loaded: false, userMessages: 1 } });
    const read = await api.detail(listed!);
    expect(read.prompts.map((p) => p.text)).toEqual(["fix the build"]);
    expect(read).toMatchObject({ id: "cse_9", title: "Build", modified: "2026-10-14T09:30:00Z", remote: { loaded: true } });
    expect(remoteUrl("cse_9")).toBe("https://claude.ai/code/cse_9");
  });
});

describe("the filter for remote sessions", () => {
  const own = join(tmpdir(), "own");
  const filter = (remote: SessionFilter["remote"]): SessionFilter => ({ folders: "this", accounts: [own], background: "show", remote });
  const remoteSession = remoteSummary({ id: "cse_1", refs: [] });
  const local = { id: "a", path: join(tmpdir(), "x", "a.jsonl"), prompts: [], plans: [], files: [] };

  it("lets them through unless hidden, whatever the folder", () => {
    expect(passesFilter(remoteSession, filter("show"), own, tmpdir(), undefined)).toBe(true);
    expect(passesFilter(remoteSession, filter("only"), own, tmpdir(), undefined)).toBe(true);
    expect(passesFilter(remoteSession, filter("hide"), own, tmpdir(), undefined)).toBe(false);
  });

  it("leaves the sessions of this machine out when only the remote ones are wanted", () => {
    mkdirSync(join(tmpdir(), "x"), { recursive: true });
    expect(passesFilter(local, filter("only"), own, tmpdir(), undefined)).toBe(false);
  });
});

describe("the settings and the doctor", () => {
  afterAll(() => updateSettings({ remoteApi: false, sessionsRemote: "show" }));

  it("keep remote sessions off until asked, and fall back for a value that is none", () => {
    expect(DEFAULT_SETTINGS.remoteApi).toBe(false);
    expect(DEFAULT_SETTINGS.sessionsRemote).toBe("show");
    writeJson(settingsFile(), { sessionsRemote: "sometimes", remoteApi: "yes" });
    expect(readSettings()).toMatchObject({ sessionsRemote: "show", remoteApi: false });
  });

  it("checks the login only while the remote API is on", () => {
    const environment = () => diagnoseGroup("Environment", { cwd: tmpdir() }).filter((f) => f.text.startsWith("remote API"));
    updateSettings({ remoteApi: false });
    expect(environment()).toEqual([]);
    updateSettings({ remoteApi: true });
    // The tests' config folder holds no login.
    expect(environment()).toMatchObject([{ severity: "warn", text: expect.stringContaining("no login") }]);
  });
});
