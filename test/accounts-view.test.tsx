import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { proc } from "../src/proc.js";
import { renderInk, until } from "./helpers/ink.js";
import type { Account } from "../src/account.js";
import { accountSessions, transcriptTitle } from "../src/accountsInfo.js";
import { readSettings } from "../src/settings.js";
import { projectSlug } from "../src/transcript/locate.js";
import { accountEntries, AccountsView } from "../src/tui/AccountsView.js";
import { tabAt, type Layout } from "../src/tui/layout.js";
import { AccountContext, type AccountState } from "../src/tui/useAccount.js";

const layout: Layout = { columns: 120, rows: 30, listWidth: 40, previewWidth: 77, bodyHeight: 26 };
const cwd = join(tmpdir(), "cco-accounts-project");
const spawned: { cmd: string; args: string[] }[] = [];
const real = { ...proc };
beforeAll(() => {
  proc.spawn = ((cmd: string, args: string[]) => {
    spawned.push({ cmd, args });
    return Object.assign(new EventEmitter(), { unref: () => {} });
  }) as never;
});
afterAll(() => {
  Object.assign(proc, real);
});

let saved: string | undefined;
let savedTerminal: Record<string, string | undefined> = {};
let own: string;
let other: string;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  own = mkdtempSync(join(tmpdir(), "cco-accounts-own-"));
  other = mkdtempSync(join(tmpdir(), "cco-accounts-other-"));
  process.env.CLAUDE_CONFIG_DIR = own;
  spawned.length = 0;
  savedTerminal = { TMUX: process.env.TMUX, WT_SESSION: process.env.WT_SESSION, WT_PROFILE_ID: process.env.WT_PROFILE_ID };
  for (const v of ["TMUX", "WT_SESSION", "WT_PROFILE_ID"]) delete process.env[v];
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
  for (const [key, value] of Object.entries(savedTerminal)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const account = (dir: string, email: string): Account => ({ dir, file: join(dir, ".claude.json"), email, organization: "Org" });
const stateOf = (): AccountState => {
  const accounts = [account(own, "me@home.de"), account(other, "jan@work.com")];
  return { accounts, current: accounts[0], multiple: true, own };
};
const line = (entry: object) => JSON.stringify(entry) + "\n";

/** A transcript of the project in the other account, with a title at its end. */
function otherSession(id: string, title: string) {
  const dir = join(other, "projects", projectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    line({ type: "user", uuid: "u", message: { role: "user", content: "hi" } }) + line({ type: "custom-title", customTitle: title, sessionId: id }),
  );
}

const render = (props: Partial<Parameters<typeof AccountsView>[0]> = {}) =>
  renderInk(
    <AccountContext.Provider value={stateOf()}>
      <AccountsView cwd={cwd} layout={layout} visible active {...props} />
    </AccountContext.Provider>,
    layout,
  );

describe("the Accounts view", () => {
  it("is the cco at the start of the top bar", () => {
    expect(tabAt(0, readSettings(), "chat")).toBe("accounts");
    expect(tabAt(2, readSettings(), "chat")).toBe("accounts");
    expect(tabAt(5, readSettings(), "chat")).toBe("chat");
  });

  it("lists the active account first, the others by email, then how they are found; a note without any", () => {
    const a = account("/a", "zed@x");
    const b = account("/b", "amy@x");
    const c = account("/c", "bob@x");
    expect(accountEntries({ accounts: [b, a, c], current: a }).map((e) => (e.kind === "account" ? e.account.email : e.kind))).toEqual(["zed@x", "amy@x", "bob@x", "details"]);
    expect(accountEntries({ accounts: [] }).map((e) => e.kind)).toEqual(["none", "details"]);
  });

  it("reads the sessions of the project in another account without reading them in full", () => {
    otherSession("s1", "Orders work");
    writeFileSync(join(other, "projects", projectSlug(cwd), "tiny.jsonl"), line({ type: "bridge-session" }));
    const s = accountSessions(other, cwd);
    expect(s.count).toBe(1);
    expect(s.newest?.title).toBe("Orders work");
    expect(transcriptTitle(join(other, "nothing.jsonl"), 0)).toBeUndefined();
  });

  it("shows an account's details: the plugin, what runs and the project's sessions there", async () => {
    otherSession("s1", "Orders work");
    mkdirSync(join(other, "sessions"), { recursive: true });
    writeFileSync(join(other, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s1", cwd: join(tmpdir(), "orders"), status: "busy" }));
    const view = render();
    await until(() => view.frame().includes("jan@work.com"));
    await view.press("\u001b[B");
    await until(() => view.frame().includes("Running now (1)"));
    const frame = view.frame();
    expect(frame).toContain("not installed");
    expect(frame).toContain("orders · working");
    expect(frame).toContain("Sessions of cco-accounts-project (1)");
    expect(frame).toContain("Orders work");
    view.unmount();
  });

  it("opens an account's menu on Enter: continuing is greyed out on the active account and without a session", async () => {
    const view = render({ noSession: "this viewer follows no Claude Code" });
    await until(() => view.frame().includes("jan@work.com"));
    await view.press("g");
    await view.press("\r");
    await until(() => view.frame().includes("Start a new session there"));
    expect(view.frame()).toContain("it is this session's account");
    // The first entry that can be chosen is selected: a new session.
    expect(view.frame()).toMatch(/› +Start a new session there/);
    await view.press("\u001b");
    await until(() => !view.frame().includes("Start a new session there"));
    await view.press("\u001b[B");
    await view.press("\r");
    await until(() => view.frame().includes("Open its config folder"));
    expect(view.frame()).toContain("this viewer follows no Claude Code");
    view.unmount();
  });

  it("starts a new session in the other account, in a new window under its folder", async () => {
    process.env.WT_SESSION = "x";
    mkdirSync(join(other, "plugins"), { recursive: true });
    writeFileSync(join(other, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "cco@cc-outline": [{ scope: "user" }] } }));
    const view = render();
    await until(() => view.frame().includes("jan@work.com"));
    await view.press("g");
    await view.press("\u001b[B");
    await view.press("\r");
    await until(() => view.frame().includes("Start a new session there"));
    await view.press("2");
    await until(() => spawned.some((c) => c.cmd === "wt"));
    const args = spawned.find((c) => c.cmd === "wt")!.args;
    expect(args.slice(0, 3)).toEqual(["-w", "new", "new-tab"]);
    expect(args.slice(-6, -1)).toEqual(["claude", "--config-dir", other, "--", "--session-id"]);
    view.unmount();
  });
});
