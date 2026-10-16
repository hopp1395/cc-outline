import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remote, type RemoteEvent } from "../src/remote/api.js";
import { SESSIONS_SCOPE } from "../src/remote/credentials.js";
import { pendingRequests } from "../src/remote/pending.js";
import { toTranscript } from "../src/remote/toTranscript.js";
import { isViewShown, readSettings, setSessionViewer } from "../src/settings.js";
import { TranscriptParser } from "../src/transcript/parse.js";
import { App } from "../src/tui/App.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";
import { renderInk, until } from "./helpers/ink.js";

/** A session recorded from the Claude app (iOS): a prompt, an AskUserQuestion answered there, /plan, a prompt interrupted. */
const capture = readFileSync(join(import.meta.dirname, "fixtures", "remote-capture.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { kind: "event" | "session"; data: Record<string, unknown> });
const rawEvents = capture.filter((c) => c.kind === "event").map((c) => c.data);
const events: RemoteEvent[] = rawEvents.map((e) => ({
  sequence: Number(e.sequence_num),
  createdAt: e.created_at as string,
  source: e.source as string,
  payload: e.payload as Record<string, unknown>,
}));
const session = capture.find((c) => c.kind === "session")!.data;
const upTo = (n: number) => events.filter((e) => e.sequence <= n);

describe("the recorded session", () => {
  it("waits for the AskUserQuestion until the app answered it", () => {
    const waiting = pendingRequests(upTo(34));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ toolName: "AskUserQuestion", displayName: "AskUserQuestion", needsInteraction: true });
    expect((waiting[0]!.input.questions as { question: string }[])[0]!.question).toBe("Welche Farbe magst du?");
    expect(pendingRequests(events)).toEqual([]);
  });

  it("does not count a client's requests (initialize, interrupt) as waiting", () => {
    expect(pendingRequests(upTo(19))).toEqual([]);
    expect(pendingRequests(upTo(48))).toEqual([]);
  });

  it("reads as a transcript: the prompts typed on the phone, the answer, the interrupt", () => {
    const parser = new TranscriptParser({ dedupe: true });
    parser.push(toTranscript(events).lines.join("\n") + "\n");
    const prompts = parser.turns.map((t) => t.prompt);
    expect(prompts).toContain("lege die datei a.txt an und führe dir aus");
    expect(prompts).toContain("frag mich mit askuserquestion welche farbe ich mag");
    expect(prompts).toContain("zähle bis 10 pro sekunde ein schritt");
    const counting = parser.turns.find((t) => t.prompt.startsWith("zähle"))!;
    expect(counting.interrupted).toBe("tool");
  });
});

describe("the views of a remote viewer", () => {
  afterEach(() => setSessionViewer(false));

  it("are the chat and its settings alone, whatever the settings say", () => {
    setSessionViewer(true);
    const settings = readSettings();
    expect(isViewShown(settings, "chat")).toBe(true);
    expect(isViewShown(settings, "settings")).toBe(true);
    expect(["git", "plan", "sessions", "monitor", "accounts"].some((m) => isViewShown(settings, m as never))).toBe(false);
  });
});

describe("a remote viewer", () => {
  const realFetch = remote.fetch;
  let saved: string | undefined;
  let served: number;
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
    const dir = (process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-remote-app-")));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3_600_000, scopes: [SESSIONS_SCOPE] } }));
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", organizationUuid: "org-1" } }));
    // The events arrive in two polls: up to the question, then the rest.
    served = 34;
    remote.fetch = async (url) => {
      const body = url.includes("/events")
        ? { data: rawEvents.filter((e) => Number(e.sequence_num) <= served).reverse() }
        : { data: [{ ...session, title: "rc-test" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    setSessionViewer(true);
  });
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = saved;
    remote.fetch = realFetch;
    setSessionViewer(false);
  });

  it("shows the session live in the chat, with what it does, its two tabs and the title", async () => {
    const layout: Layout = { columns: 110, rows: 26, listWidth: 40, previewWidth: 67, bodyHeight: 22 };
    const app = renderInk(<App cwd={tmpdir()} remoteId={String(session.id)} initialMode="chat" />, layout, {
      wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
    });
    await until(() => app.frame().includes("frag mich mit askuserquestion"));
    expect(app.frame()).not.toContain("zähle bis 10");
    const tabs = app.frame().split("\n")[0]!;
    // Without remote control it only observes.
    expect(tabs).toContain(" observing ");
    expect(tabs).toContain("rc-test");
    expect(tabs).toContain(" 1 Chat ");
    expect(tabs).toContain(" 6 Settings ");
    expect(tabs).not.toContain("Sessions");
    expect(tabs).not.toContain("Plan");
    expect(tabs).not.toContain("Changes");
    served = 1000;
    await until(() => app.frame().includes("zähle bis 10"));
    app.unmount();
  });
});
