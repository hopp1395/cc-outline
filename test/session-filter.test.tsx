import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, until } from "./helpers/ink.js";
import { filterIsSet, filterSettings, sessionFilter } from "../src/sessionFilter.js";
import { readSettings, updateSettings } from "../src/settings.js";
import { projectDir } from "../src/transcript/locate.js";
import { SessionReader } from "../src/transcript/sessions.js";
import type { Layout } from "../src/tui/layout.js";
import { SessionsView } from "../src/tui/SessionsView.js";

const layout: Layout = { columns: 120, rows: 26, listWidth: 40, previewWidth: 77, bodyHeight: 22 };
const DOWN = "\u001b[B";
const RIGHT = "\u001b[C";

const line = (entry: object) => JSON.stringify(entry) + "\n";
const prompt = (id: string, text: string, extra: object = {}) =>
  line({ type: "user", uuid: `${id}-u`, timestamp: new Date().toISOString(), message: { role: "user", content: text }, ...extra });

describe("background sessions in the transcript", () => {
  it("are those of claude -p and the SDK, and those the daemon runs", () => {
    expect(new SessionReader("a.jsonl").push(prompt("a", "typed", { entrypoint: "cli" })).background).toBeUndefined();
    expect(new SessionReader("b.jsonl").push(prompt("b", "scripted", { entrypoint: "sdk-cli" })).background).toBe("sdk");
    // A session sent to the background counts as the daemon's from then on.
    const sent = prompt("c", "typed", { entrypoint: "cli" }) + prompt("d", "later", { entrypoint: "cli", sessionKind: "bg" });
    expect(new SessionReader("c.jsonl").push(sent).background).toBe("daemon");
  });
});

describe("the filter's settings", () => {
  const own = join(tmpdir(), "own");
  const work = join(tmpdir(), "work");
  const home = join(tmpdir(), "home");
  const settings = (sessionsAccounts: string) => ({ sessionsFolders: "this" as const, sessionsAccounts, sessionsBackground: "show" as const });

  it("reads current, all and the folders named, falling back to this account", () => {
    expect(sessionFilter(settings("current"), own, [work, home]).accounts).toEqual([own]);
    expect(sessionFilter(settings("all"), own, [work, home]).accounts).toEqual([own, work, home]);
    expect(sessionFilter(settings(`${home}|${own}`), own, [work, home]).accounts).toEqual([own, home]);
    // An account no longer found drops out; none left is this one.
    expect(sessionFilter(settings(join(tmpdir(), "gone")), own, [work]).accounts).toEqual([own]);
  });

  it("stores this account alone as current and every one found as all, so a new one shows too", () => {
    const store = (accounts: string[]) => filterSettings({ folders: "all", accounts, background: "hide" }, own, [work, home]);
    expect(store([own])).toEqual({ sessionsFolders: "all", sessionsAccounts: "current", sessionsBackground: "hide" });
    expect(store([home, own, work]).sessionsAccounts).toBe("all");
    expect(store([own, home]).sessionsAccounts).toBe(`${own}|${home}`);
    expect(store([work]).sessionsAccounts).toBe(work);
  });

  it("counts as set when it leaves this folder, this account or all background sessions", () => {
    const base = { folders: "this" as const, accounts: [own], background: "show" as const };
    expect(filterIsSet(base, own)).toBe(false);
    expect(filterIsSet({ ...base, folders: "all" }, own)).toBe(true);
    expect(filterIsSet({ ...base, accounts: [own, work] }, own)).toBe(true);
    expect(filterIsSet({ ...base, background: "hide" }, own)).toBe(true);
  });
});

describe("the filter dialog in Sessions", () => {
  let saved: string | undefined;
  let cwd: string;
  let elsewhere: string;
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-session-filter-"));
    cwd = mkdtempSync(join(tmpdir(), "cco-session-filter-project-"));
    elsewhere = mkdtempSync(join(tmpdir(), "cco-session-filter-elsewhere-"));
  });
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = saved;
  });

  /** A session of `folder`, its prompt `minutes` ago, run by `entrypoint`. */
  function session(folder: string, id: string, text: string, minutes: number, extra: object = {}) {
    mkdirSync(projectDir(folder), { recursive: true });
    const ts = new Date(Date.now() - minutes * 60_000).toISOString();
    const file = join(projectDir(folder), `${id}.jsonl`);
    writeFileSync(file, line({ type: "user", uuid: `${id}-u`, timestamp: ts, cwd: folder, message: { role: "user", content: text }, ...extra }));
    // The list goes by the last write: written at once, the files' times would not tell the newest.
    utimesSync(file, new Date(ts), new Date(ts));
  }

  it("marks the background sessions and shows them alone, then leaves them out", async () => {
    session(cwd, "typed", "typed here", 10, { entrypoint: "cli" });
    session(cwd, "script", "scripted run", 5, { entrypoint: "sdk-cli" });
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout);
    await until(() => view.frame().includes("typed here") && view.frame().includes("scripted run"));
    // Before the name, where all folders put the project's.
    expect(view.frame()).toMatch(/◌ „scripted run/);
    expect(view.frame()).not.toMatch(/◌ „typed here/);
    // The newest, the background one, is selected: its header says how it ran.
    expect(view.frame()).toContain("◌ background: claude -p / SDK");
    await view.press("a");
    await until(() => view.frame().includes("Show sessions"));
    // One account: no accounts group, the background row follows the folders.
    expect(view.frame()).not.toContain("Accounts");
    await view.press(DOWN);
    await view.press(DOWN);
    await view.press(RIGHT);
    await view.press("\r");
    await expect.poll(() => readSettings().sessionsBackground).toBe("only");
    await until(() => !view.frame().includes("typed here"));
    await view.press("a");
    await until(() => view.frame().includes("Show sessions"));
    await view.press(DOWN);
    await view.press(DOWN);
    await view.press(" ");
    await view.press("\r");
    await expect.poll(() => readSettings().sessionsBackground).toBe("hide");
    await until(() => view.frame().includes("typed here") && !view.frame().includes("scripted run"));
    view.unmount();
  });

  it("lists the other folders without this one, and keeps one folder checked", async () => {
    session(cwd, "here", "work here", 10);
    session(elsewhere, "there", "work elsewhere", 5, { entrypoint: "sdk-cli" });
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active />, layout);
    await until(() => view.frame().includes("work here"));
    expect(view.frame()).not.toContain("work elsewhere");
    await view.press("a");
    await until(() => view.frame().includes("Show sessions"));
    // Only this folder is checked: it stays.
    await view.press(" ");
    await until(() => view.frame().includes("one folder stays checked"));
    await view.press(DOWN);
    await view.press(" ");
    await view.press("\u001b[A");
    await view.press(" ");
    await view.press("\r");
    await expect.poll(() => readSettings().sessionsFolders).toBe("other");
    await until(() => view.frame().includes("work elsewhere") && !view.frame().includes("work here"));
    // The background mark comes before the project's name.
    expect(view.frame()).toMatch(/◌ cco-session/);
    view.unmount();
  });

  it("keeps the active session whatever the filter says", async () => {
    updateSettings({ sessionsBackground: "only" });
    session(cwd, "mine", "my session", 10);
    const active = join(projectDir(cwd), "mine.jsonl");
    const view = renderInk(<SessionsView cwd={cwd} layout={layout} visible active activePath={active} />, layout);
    await until(() => view.frame().includes("my session"));
    view.unmount();
  });
});
