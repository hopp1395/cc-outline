import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Account } from "../src/account.js";
import { accountOfSession, shownAccount, usageBadge, type BadgeLooks } from "../src/rcViewer/usageAccount.js";
import { remote } from "../src/remote/api.js";
import { quotaNote, quotaOf, quotaSource } from "../src/remote/quota.js";
import { badgeWidth, fitUsage, fitUsageLine, usageWidth, type RemoteUsage, type UsagePart } from "../src/remote/usage.js";
import { setOwnSettings, updateSettings } from "../src/settings.js";
import { claudeDir, inClaudeDir, projectDir } from "../src/transcript/locate.js";
import type { SessionSummary } from "../src/transcript/sessions.js";
import type { Layout } from "../src/tui/layout.js";
import { RcViewerApp } from "../src/tui/RcViewerApp.js";
import { SessionComposer, usageSpan, type PromptChannel } from "../src/tui/SessionComposer.js";
import { renderInk, until } from "./helpers/ink.js";

const account = (dir: string, email: string, extra: Partial<Account> = {}): Account => ({ dir, file: join(dir, ".claude.json"), email, ...extra });
const summary = (extra: Partial<SessionSummary> = {}): SessionSummary => ({ id: "s", path: "/p/s.jsonl", prompts: [], plans: [], files: [], ...extra });

describe("whose usage windows the Remote Control Viewer shows", () => {
  const own = account("/home/.claude", "me@work.com");
  const other = account("/home/.claude-private", "me@home.com", { avatar: "🐙", chosenColor: "magenta" });
  const api = account("/home/.claude-api", "sonnet @ proxy", { api: { baseUrl: "https://proxy" } });
  const accounts = [own, other, api];

  it("takes the selected session's account: another account's by its folder, a remote one and one of this folder the own", () => {
    expect(accountOfSession(summary({ account: "/home/.claude-private" }), accounts, own)).toBe(other);
    expect(accountOfSession(summary(), accounts, own)).toBe(own);
    expect(accountOfSession(summary({ remote: { loaded: false } }), accounts, own)).toBe(own);
    expect(accountOfSession(undefined, accounts, own)).toBe(own);
    // A folder that is no account found has no windows.
    expect(accountOfSession(summary({ account: "/home/.claude-gone" }), accounts, own)).toBeUndefined();
  });

  it("keeps an account chosen by hand while it is found, else follows the session", () => {
    expect(shownAccount(undefined, own, accounts)).toEqual({ account: own, pinned: false });
    expect(shownAccount("/home/.claude-private", own, accounts)).toEqual({ account: other, pinned: true });
    expect(shownAccount("/home/.claude-gone", own, accounts)).toEqual({ account: own, pinned: false });
  });

  it("draws the badge with the account's avatar and colour, the pin, and a note where there are no windows", () => {
    const looks: BadgeLooks = { info: { own: own.dir }, color: "off", avatar: "" };
    expect(usageBadge(own, looks, {})).toEqual({ avatar: "cco" });
    expect(usageBadge(other, looks, {}, true)).toEqual({ avatar: "🐙", color: "magenta", pinned: true });
    expect(usageBadge(own, { ...looks, color: "cyan", avatar: "🦊" }, {})).toEqual({ avatar: "🦊", color: "cyan" });
    expect(usageBadge(api, looks, {}).note).toBe("API");
    expect(usageBadge(other, looks, { errorKind: "expired" }).note).toBe("expired");
    // Windows kept from before show (dim) in place of the reason.
    expect(usageBadge(other, looks, { errorKind: "expired", limits: { seen: "" } }).note).toBeUndefined();
    expect(quotaNote("no-login")).toBe("no login");
    expect(quotaOf({ nextAt: 0, failures: 1, error: { kind: "no-scope", message: "m" } }, undefined).errorKind).toBe("no-scope");
  });

  it("counts the badge before the windows and drops it last when the line shortens", () => {
    const parts: UsagePart[] = [
      { label: "Ctx", value: "62k" },
      { label: "5h", value: "23%", level: "low", percent: 23, rest: "↻ 2h14m" },
      { label: "7d", value: "97%", level: "high", percent: 97, rest: "↻ 3d4h" },
    ];
    // ` AA ` on its colour.
    const badge = badgeWidth({ avatar: "AA", color: "red" });
    expect(badge).toBe(4);
    expect(badgeWidth({ avatar: "AA", pinned: true, note: "API" })).toBe(2 + 2 + 4);
    expect(usageWidth(parts, badge)).toBe(40 + 4 + 1);
    expect(usageWidth([{ label: "Ctx", value: "62k" }], badge)).toBe(7 + 3 + 4);
    expect(usageWidth([], badge)).toBe(4);
    const labels = (room: number) => fitUsage(parts, room, badge).map((p) => p.label);
    expect(labels(45)).toEqual(["Ctx", "5h", "7d"]);
    expect(labels(20)).toEqual(["5h", "7d"]);
    expect(labels(19)).toEqual(["7d"]);
    expect(labels(11)).toEqual(["7d"]);
    expect(labels(4)).toEqual([]);
    const usage: RemoteUsage = { limits: { fiveHour: { utilization: 0.5 }, seen: "" }, badge: { avatar: "AA" } };
    expect(fitUsageLine(usage, 4, 0)).toEqual({ parts: [], badge: true, width: 2 });
    expect(fitUsageLine(usage, 1, 0)).toEqual({ parts: [], badge: false, width: 0 });
  });
});

describe("the badge in the prompt line's frame", () => {
  const layoutOf = (columns: number): Layout => ({ columns, rows: 24, listWidth: 0, previewWidth: columns, bodyHeight: 24 });
  const channel: PromptChannel = { send: async () => {}, interrupt: async () => {} };
  const at = (s: number) => Date.now() / 1000 + s;
  const limits = { fiveHour: { utilization: 0.23, resetsAt: at(2 * 3600 + 14 * 60 + 30) }, sevenDay: { utilization: 0.97, resetsAt: at(3 * 86400 + 4 * 3600 + 30) }, seen: "" };
  const bottom = (columns: number, usage: RemoteUsage) => {
    const layout = layoutOf(columns);
    const view = renderInk(<SessionComposer layout={layout} channel={channel} title="t" working={false} focused={false} onFocus={() => {}} notify={() => {}} onHeight={() => {}} usage={usage} />, layout);
    const line = view.frame().split("\n").filter((l) => l.trim()).at(-1)!;
    view.unmount();
    return line;
  };

  it("stands before the windows, after the context, with its pin and note", () => {
    expect(bottom(70, { context: 62_400, limits, badge: { avatar: "AA", color: "red" } })).toBe(`${"─".repeat(21)} Ctx 62k ·  AA  5h 23% ↻ 2h14m · 7d 97% ↻ 3d4h ──`);
    expect(bottom(40, { limits, badge: { avatar: "BB", pinned: true } })).toMatch(/─ 📌BB 5h 23% · 7d 97% ──$/);
    expect(bottom(40, { context: 1000, badge: { avatar: "CC", note: "API" } })).toBe(`${"─".repeat(21)} Ctx 1k · CC API ──`);
  });

  it("names the columns a click on it opens the list from", () => {
    expect(usageSpan({ badge: { avatar: "AA" } }, 40, 0)).toEqual({ start: 35, end: 37 });
    expect(usageSpan({}, 40, 0)).toBeUndefined();
    expect(usageSpan(undefined, 40, 0)).toBeUndefined();
  });
});

describe("the Remote Control Viewer's usage per account", () => {
  const size = { columns: 140, rows: 30 };
  const saved = { ...process.env };
  const realGet = quotaSource.get;
  const realFetch = remote.fetch;
  let mine: string;
  let theirs: string;
  let cwd: string;
  /** What claude.ai tells of each account, by its folder. */
  const usageOf = (dir: string | undefined) => {
    const share = dir === theirs ? [91, 64] : [23, 41];
    const resets = new Date(Date.now() + 3 * 3600_000).toISOString();
    return { five_hour: { utilization: share[0], resets_at: resets }, seven_day: { utilization: share[1], resets_at: resets } };
  };
  beforeAll(() => {
    quotaSource.get = async (dir) => usageOf(dir);
    remote.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  afterAll(() => {
    quotaSource.get = realGet;
    remote.fetch = realFetch;
  });
  beforeEach(() => {
    mine = process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-usage-mine-"));
    theirs = mkdtempSync(join(tmpdir(), "cco-usage-theirs-"));
    cwd = mkdtempSync(join(tmpdir(), "cco-usage-project-"));
    setOwnSettings("rcViewer");
    updateSettings({ remoteApi: true, accountAvatar: "AA" });
  });
  afterEach(() => {
    updateSettings({ remoteApi: false, accountAvatar: "" });
    process.env = { ...saved };
  });

  /** A session of the account of config folder `dir`, its prompt `minutes` ago. */
  function session(dir: string, id: string, title: string, minutes: number) {
    const ts = new Date(Date.now() - minutes * 60_000).toISOString();
    const folder = inClaudeDir(dir, () => projectDir(cwd));
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, `${id}.jsonl`),
      [
        { type: "user", uuid: `${id}-u`, timestamp: ts, cwd, message: { role: "user", content: `prompt of ${title}` } },
        { type: "assistant", uuid: `${id}-a`, timestamp: ts, cwd, message: { id: `${id}-m`, role: "assistant", content: [{ type: "text", text: `answer of ${title}` }], stop_reason: "end_turn" } },
        { type: "custom-title", customTitle: title, sessionId: id },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
  }

  let current: { frame(): string } | undefined;
  const waitFor = async (check: () => boolean) => {
    await until(check);
    if (!check()) throw new Error(`not shown:
${current?.frame()}`);
  };
  /** Selects the session `title` in the sessions column (the other account's sessions may come in later, above). */
  const select = async (view: { frame(): string; press(keys: string): Promise<void> }, title: string) => {
    const shown = () => view.frame().includes(`answer of ${title}`);
    for (const key of ["g", "[B", "[B"]) {
      await view.press(key);
      await until(shown, 20);
      if (shown()) return;
    }
    await waitFor(shown);
  };
  const border = (frame: string) => frame.split("\n").filter((l) => l.trim()).at(-1)!;

  it("follows the selected session's account, and keeps one chosen in the list until Automatic", async () => {
    session(mine, "s-mine", "my work", 5);
    session(theirs, "s-theirs", "their work", 10);
    const accounts = [account(mine, "me@work.com"), account(theirs, "me@home.com", { avatar: "BB", chosenColor: "magenta" })];
    const view = (current = renderInk(<RcViewerApp accounts={{ accounts, current: accounts[0], multiple: true, own: claudeDir() }} />, size));
    await waitFor(() => view.frame().includes("my work") && view.frame().includes("their work"));
    await select(view, "my work");
    await waitFor(() => border(view.frame()).includes("5h 23%"));
    expect(border(view.frame())).toMatch(/ AA  5h 23% ↻ \dh\d+m · 7d 41% ↻ \dh\d+m ──$/);

    // The other account's session shows that account's windows.
    await select(view, "their work");
    await waitFor(() => border(view.frame()).includes("5h 91%"));
    expect(border(view.frame())).toMatch(/ BB  5h 91% .* · 7d 64% /);

    // u opens the list: Automatic with the session's badge, then every account with its windows.
    await view.press("u");
    await waitFor(() => view.frame().includes("Usage of"));
    await waitFor(() => view.frame().includes("me@work.com") && /me@work\.com +5h 23% · 7d 41%/.test(view.frame()));
    expect(view.frame()).toMatch(/› Automatic \(follows the session\)  BB /);
    expect(view.frame()).toMatch(/me@home\.com +5h 91% · 7d 64%/);
    // Choosing the own account keeps it, whichever session is selected.
    await view.press("\u001b[B");
    await view.press("\r");
    await waitFor(() => !view.frame().includes("Usage of") && border(view.frame()).includes("📌"));
    expect(border(view.frame())).toMatch(/📌 AA  5h 23%/);
    await select(view, "my work");
    expect(border(view.frame())).toMatch(/📌 AA  5h 23%/);
    await select(view, "their work");
    expect(border(view.frame())).toMatch(/📌 AA  5h 23%/);

    // Automatic follows the session again; Esc closes the list without a change.
    await view.press("u");
    await waitFor(() => view.frame().includes("Usage of"));
    expect(view.frame()).toMatch(/› .*me@work\.com/);
    await view.press("\u001b[A");
    await view.press("\r");
    await waitFor(() => !border(view.frame()).includes("📌") && border(view.frame()).includes("5h 91%"));
    await view.press("u");
    await waitFor(() => view.frame().includes("Usage of"));
    await view.press("\u001b");
    await waitFor(() => !view.frame().includes("Usage of"));
    expect(border(view.frame())).toMatch(/ BB  5h 91%/);
    view.unmount();
  }, 15_000);

  it("opens the list with a click on the usage, and shows nothing of it without the remote API", async () => {
    session(mine, "s-mine", "my work", 5);
    const accounts = [account(mine, "me@work.com")];
    const view = (current = renderInk(<RcViewerApp accounts={{ accounts, current: accounts[0], multiple: false, own: claudeDir() }} />, size));
    await waitFor(() => border(view.frame()).includes("5h 23%"));
    const line = border(view.frame());
    // One-based cell of the badge.
    await view.click(line.indexOf("AA") + 1, size.rows);
    await waitFor(() => view.frame().includes("Usage of"));
    expect(view.frame()).toContain("Automatic (follows the session)");
    // A click beside it closes it.
    await view.click(2, 3);
    await waitFor(() => !view.frame().includes("Usage of"));
    updateSettings({ remoteApi: false });
    await waitFor(() => !border(view.frame()).includes("AA"));
    expect(border(view.frame())).toMatch(/^─+$/);
    view.unmount();
  }, 15_000);
});
