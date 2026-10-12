import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, until } from "./helpers/ink.js";
import { barColorOfAccount, type Account } from "../src/account.js";
import { readFavorites } from "../src/favorites.js";
import { readSettings, updateSettings } from "../src/settings.js";
import { projectSlug } from "../src/transcript/locate.js";
import { SessionIndex } from "../src/transcript/sessions.js";
import type { Layout } from "../src/tui/layout.js";
import { sessionKey, SessionsView } from "../src/tui/SessionsView.js";
import { AccountContext, type AccountState } from "../src/tui/useAccount.js";

const layout: Layout = { columns: 130, rows: 26, listWidth: 44, previewWidth: 83, bodyHeight: 22 };

let saved: string | undefined;
let savedTerminal: Record<string, string | undefined> = {};
let own: string;
let other: string;
let cwd: string;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  own = mkdtempSync(join(tmpdir(), "cco-sessions-own-"));
  other = mkdtempSync(join(tmpdir(), "cco-sessions-other-"));
  cwd = mkdtempSync(join(tmpdir(), "cco-sessions-accounts-project-"));
  process.env.CLAUDE_CONFIG_DIR = own;
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

const account = (dir: string, email: string, chosenColor?: Account["chosenColor"]): Account => ({ dir, file: join(dir, ".claude.json"), email, organization: "Org", chosenColor });
const stateOf = (otherColor?: Account["chosenColor"]): AccountState => {
  const accounts = [account(own, "me@home.de"), account(other, "jan@work.com", otherColor)];
  return { accounts, current: accounts[0], multiple: true, own };
};

/** A session of the project in the config folder `dir`, its prompt `minutes` ago. */
function session(dir: string, id: string, text: string, minutes: number) {
  const folder = join(dir, "projects", projectSlug(cwd));
  mkdirSync(folder, { recursive: true });
  const ts = new Date(Date.now() - minutes * 60_000).toISOString();
  writeFileSync(join(folder, `${id}.jsonl`), JSON.stringify({ type: "user", uuid: `${id}-u`, timestamp: ts, cwd, message: { role: "user", content: text } }) + "\n");
}

const render = (state = stateOf()) =>
  renderInk(
    <AccountContext.Provider value={state}>
      <SessionsView cwd={cwd} layout={layout} visible active />
    </AccountContext.Provider>,
    layout,
  );

describe("Sessions with the other accounts", () => {
  it("reads another account's folder and marks its sessions with it", async () => {
    session(other, "s1", "work there", 5);
    const found = await new SessionIndex(other).scan(cwd);
    expect(found.map((s) => [s.id, s.account])).toEqual([["s1", other]]);
    expect(sessionKey(found[0]!)).toBe(`${other}|s1`);
    // The viewer's own folder is untouched.
    expect(await new SessionIndex().scan(cwd)).toEqual([]);
  });

  it("goes round the four scopes with a, listing the other account's sessions with a bar from the third on", async () => {
    updateSettings({ sessionsScope: "project" });
    session(own, "a1", "work here", 10);
    session(other, "b1", "work there", 5);
    const view = render();
    await until(() => view.frame().includes("work here"));
    expect(view.frame()).not.toContain("work there");
    expect(view.frame()).not.toContain("▌");
    await view.press("a");
    await expect.poll(() => readSettings().sessionsScope).toBe("all");
    await view.press("a");
    await until(() => view.frame().includes("work there"));
    await expect.poll(() => readSettings().sessionsScope).toBe("project-accounts");
    // Every row gets a bar, the own sessions too; the newest, the other account's, is selected and named in the header.
    expect(view.frame().split("\n").filter((l) => l.includes("▌ ")).length).toBeGreaterThanOrEqual(3);
    expect(view.frame()).toContain("jan@work.com (Org)");
    // The selected row (the newest, at the top) keeps its bar: drawn before the selection, outside its style.
    expect(view.frame().split("\n")[1]).toMatch(/^▌ \d\d:\d\d „work there“/);
    expect(view.frame()).toContain("cco plugin ✗ not installed");
    expect(view.frame()).toContain("a accounts");
    await view.press("a");
    await expect.poll(() => readSettings().sessionsScope).toBe("all-accounts");
    await view.press("a");
    await until(() => !view.frame().includes("work there"));
    await expect.poll(() => readSettings().sessionsScope).toBe("project");
    view.unmount();
  });

  it("marks another account's session under its folder, refuses to delete it, and offers to continue it there", async () => {
    updateSettings({ sessionsScope: "project-accounts" });
    session(own, "s1", "work here", 10);
    // The same id in both accounts: a session continued there kept it.
    session(other, "s1", "work there", 5);
    const view = render();
    await until(() => view.frame().includes("work there") && view.frame().includes("work here"));
    await view.press(" ");
    await expect.poll(() => readFavorites(cwd, "sessions")).toEqual([`${other}|s1`]);
    await view.press("d");
    await until(() => view.frame().includes("only for sessions of this account"));
    await view.press("\r");
    await until(() => view.frame().includes("Continue it in a new window"));
    // The same head as for this account's sessions, naming its account; what works only here is greyed out.
    expect(view.frame()).toContain("▌ jan@work.com");
    expect(view.frame()).toContain("runs nowhere");
    expect(view.frame()).toContain("Rename it");
    // Without a terminal, copying the command is selected.
    expect(view.frame()).toMatch(/› +Copy the command/);
    view.unmount();
  });

  it("draws the bar gray for an account whose colour is off", () => {
    const state = stateOf("off");
    expect(barColorOfAccount(state.accounts[1]!, state, "auto")).toBe("gray");
    expect(barColorOfAccount(state.accounts[0]!, state, "off")).toBe("gray");
    const red = stateOf("red");
    expect(barColorOfAccount(red.accounts[1]!, red, "auto")).toBe("red");
  });
});
