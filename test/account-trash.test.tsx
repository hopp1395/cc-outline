import { existsSync, mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, until } from "./helpers/ink.js";
import type { Account } from "../src/account.js";
import { accountsHome, startScripts } from "../src/addAccount.js";
import {
  accountDeleteBlocker,
  emptyAccountTrash,
  listAccountTrash,
  purgeAccount,
  restoreAccount,
  scriptFolder,
  sizeText,
  startScriptsOf,
  trashAccount,
} from "../src/accountTrash.js";
import { readFavorites, toggleFavorite } from "../src/favorites.js";
import type { Layout } from "../src/tui/layout.js";
import { AccountsView } from "../src/tui/AccountsView.js";
import { AccountContext, type AccountState } from "../src/tui/useAccount.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";

const layout: Layout = { columns: 120, rows: 34, listWidth: 40, previewWidth: 77, bodyHeight: 30 };

let home: string;
let bin: string;
let own: string;
let other: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["HOME", "USERPROFILE", "PATH", "Path", "CLAUDE_CONFIG_DIR"];
const realHome = accountsHome.get;
afterAll(() => {
  accountsHome.get = realHome;
});
beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v];
  home = mkdtempSync(join(tmpdir(), "cco-trash-home-"));
  bin = join(home, ".local", "bin");
  own = join(home, ".claude");
  other = join(home, ".claude-cw");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(own, "cco"), { recursive: true });
  mkdirSync(join(other, "projects", "p"), { recursive: true });
  writeFileSync(join(bin, process.platform === "win32" ? "claude.exe" : "claude"), "");
  writeFileSync(join(other, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "jan@work.com" } }));
  writeFileSync(join(other, "projects", "p", "a.jsonl"), "x".repeat(100));
  for (const s of startScripts("cw", other, bin, process.platform, home)) writeFileSync(s.file, s.text);
  accountsHome.get = () => home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.Path;
  process.env.PATH = bin;
  process.env.CLAUDE_CONFIG_DIR = own;
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

const account = (dir: string, email: string): Account => ({ dir, file: join(dir, ".claude.json"), email });

describe("the accounts trash", () => {
  it("finds the start scripts that run Claude Code under a folder", () => {
    expect(scriptFolder('set "CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-cw"', home)).toBe(other);
    expect(scriptFolder('export CLAUDE_CONFIG_DIR="$HOME/.claude-cw"', home)).toBe(other);
    expect(scriptFolder("echo hi", home)).toBeUndefined();
    writeFileSync(join(bin, "cx.cmd"), 'set "CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-cx"');
    expect(startScriptsOf(other, home).length).toBe(process.platform === "win32" ? 2 : 1);
    expect(sizeText(512)).toBe("512 B");
    expect(sizeText(3.5 * 1024 * 1024)).toBe("3.5 MB");
  });

  it("refuses the default and the active account, and one a Claude Code or a viewer runs with", () => {
    expect(accountDeleteBlocker(own, undefined, home)).toContain("default account");
    expect(accountDeleteBlocker(other, other, home)).toContain("this viewer follows");
    expect(accountDeleteBlocker(other, own, home)).toBeUndefined();
    mkdirSync(join(other, "cco"), { recursive: true });
    writeFileSync(join(other, "cco", "p.viewer-1.json"), JSON.stringify({ pid: process.ppid }));
    expect(accountDeleteBlocker(other, own, home)).toContain("a cco viewer runs with it");
    mkdirSync(join(other, "sessions"), { recursive: true });
    writeFileSync(join(other, "sessions", "1.json"), JSON.stringify({ sessionId: "s", pid: process.pid }));
    expect(accountDeleteBlocker(other, own, home)).toBe("1 Claude Code runs with it");
    expect(() => trashAccount(account(other, "jan@work.com"), own, home)).toThrow("1 Claude Code runs with it");
    expect(existsSync(other)).toBe(true);
  });

  it("moves folder and scripts to the trash, restores them, and refuses while a place is taken again", () => {
    const entry = trashAccount(account(other, "jan@work.com"), own, home);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(join(bin, process.platform === "win32" ? "cw.cmd" : "cw"))).toBe(false);
    expect(entry.sessions).toBe(1);
    expect(entry.size).toBeGreaterThanOrEqual(100);
    expect(listAccountTrash(home).map((e) => e.account.email)).toEqual(["jan@work.com"]);
    mkdirSync(other);
    expect(() => restoreAccount(entry.id, home)).toThrow("can't restore: .claude-cw exists again");
    rmdirSync(other);
    restoreAccount(entry.id, home);
    expect(existsSync(join(other, ".claude.json"))).toBe(true);
    expect(existsSync(join(bin, process.platform === "win32" ? "cw.cmd" : "cw"))).toBe(true);
    expect(listAccountTrash(home)).toEqual([]);
  });

  it("deletes for good with its mark, and empties the trash", () => {
    toggleFavorite(home, "accounts", other);
    const entry = trashAccount(account(other, "jan@work.com"), own, home);
    expect(readFavorites(home, "accounts")).toEqual([other]);
    purgeAccount(entry.id, home, home);
    expect(readFavorites(home, "accounts")).toEqual([]);
    expect(listAccountTrash(home)).toEqual([]);
    mkdirSync(other);
    writeFileSync(join(other, ".claude.json"), "{}");
    trashAccount(account(other, "x@y.z"), own, home);
    expect(emptyAccountTrash(home, home)).toBe(1);
    expect(listAccountTrash(home)).toEqual([]);
  });

  it("asks twice in the Accounts view, the folder's name typed, and shows the trash with T", async () => {
    const accounts = [account(own, "me@home.de"), account(other, "jan@work.com")];
    const state: AccountState = { accounts, current: accounts[0], multiple: true, own };
    const view = renderInk(
      <AccountContext.Provider value={state}>
        <AccountsView cwd={home} layout={layout} visible active />
      </AccountContext.Provider>,
      layout,
      { wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider> },
    );
    await until(() => view.frame().includes("jan@work.com"));
    // The default (and here active) account cannot be deleted.
    await view.press("d");
    await until(() => view.frame().includes("can't delete: ~/.claude is the default account"));
    await view.press("\u001b[B");
    // The account menu offers it too, last, in the danger zone.
    await view.press("\r");
    await until(() => view.frame().includes("Danger zone"));
    expect(view.frame()).toContain("Move this account to the trash…");
    await view.press("\u001b");
    await until(() => !view.frame().includes("Danger zone"));
    await view.press("d");
    await until(() => view.frame().includes("Move this account to the trash?"));
    expect(view.frame()).toContain("1 session");
    await view.press("\r");
    await until(() => view.frame().includes("Type .claude-cw to confirm"));
    await view.press("nope");
    await view.press("\r");
    await until(() => view.frame().includes("That is not .claude-cw"));
    await view.press("\u0015");
    await view.press(".claude-cw");
    await view.press("\r");
    await until(() => view.frame().includes("moved to the trash · u undo"));
    expect(existsSync(other)).toBe(false);
    await view.press("T");
    await until(() => view.frame().includes("TRASH · 1 account"));
    expect(view.frame()).toContain("in the trash since");
    await view.press("u");
    await until(() => view.frame().includes("restored jan@work.com"));
    expect(existsSync(join(other, ".claude.json"))).toBe(true);
    view.unmount();
  });
});

