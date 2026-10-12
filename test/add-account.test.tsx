import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderInk, until } from "./helpers/ink.js";
import { accountsHome, checkNewAccount, claudeBinDir, commandOnPath, powershellAliases, startScripts, writeAccountFiles } from "../src/addAccount.js";
import { proc } from "../src/proc.js";
import type { Layout } from "../src/tui/layout.js";
import { AccountsView } from "../src/tui/AccountsView.js";
import { addAccountLines } from "../src/tui/SettingsView.js";
import { AccountContext, type AccountState } from "../src/tui/useAccount.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";

const layout: Layout = { columns: 120, rows: 34, listWidth: 40, previewWidth: 77, bodyHeight: 30 };
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

const spawned: { cmd: string; args: string[] }[] = [];
let aliasAnswer: string | undefined = "cp=Copy-Item\r\nll=Get-ChildItem\r\n";
const real = { ...proc };
beforeAll(() => {
  proc.spawn = ((cmd: string, args: string[]) => {
    spawned.push({ cmd, args });
    return Object.assign(new EventEmitter(), { unref: () => {} });
  }) as never;
  proc.execFile = ((_cmd: string, _args: string[], _opts: object, done: (err: Error | null, stdout: string) => void) => {
    setTimeout(() => (aliasAnswer === undefined ? done(new Error("no PowerShell"), "") : done(null, aliasAnswer)), 1);
  }) as never;
});
const realHome = accountsHome.get;
afterAll(() => {
  Object.assign(proc, real);
  accountsHome.get = realHome;
});

let home: string;
let bin: string;
let elsewhere: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["HOME", "USERPROFILE", "PATH", "Path", "CLAUDE_CONFIG_DIR", "TMUX", "WT_SESSION", "WT_PROFILE_ID"];
beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v];
  home = mkdtempSync(join(tmpdir(), "cco-add-home-"));
  bin = join(home, ".local", "bin");
  elsewhere = join(home, "tools");
  mkdirSync(bin, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(bin, process.platform === "win32" ? "claude.exe" : "claude"), "");
  writeFileSync(join(elsewhere, process.platform === "win32" ? "taken.exe" : "taken"), "");
  accountsHome.get = () => home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.Path;
  process.env.PATH = [elsewhere, bin].join(process.platform === "win32" ? ";" : ":");
  process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  for (const v of ["TMUX", "WT_SESSION", "WT_PROFILE_ID"]) delete process.env[v];
  spawned.length = 0;
  aliasAnswer = "cp=Copy-Item\r\nll=Get-ChildItem\r\n";
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("adding an account", () => {
  it("puts the start scripts next to claude on the PATH", () => {
    expect(claudeBinDir()).toEqual({ dir: bin, onPath: true });
    expect(claudeBinDir({ PATH: elsewhere }, process.platform, home)).toEqual({ dir: join(home, ".local", "bin"), onPath: false });
  });

  it("refuses names a shell would run something else for, and offers an empty folder again", () => {
    const check = (command: string, folder = `.claude-${command}`, platform: NodeJS.Platform = "win32", aliases?: Map<string, string>) =>
      checkNewAccount(command, folder, { binDir: bin, aliases, platform, home });
    expect(check("cp", undefined, "win32", new Map([["cp", "Copy-Item"]]))).toEqual({ problem: "cp is a PowerShell alias of Copy-Item: it would win over cp.cmd" });
    // Without an answer from PowerShell, its default aliases count.
    expect(check("sc")).toMatchObject({ problem: expect.stringContaining("PowerShell alias") });
    expect(check("ll", undefined, "win32", new Map([["ll", "Get-ChildItem"]]))).toMatchObject({ problem: expect.stringContaining("Get-ChildItem") });
    expect(check("dir", undefined, "win32", new Map())).toMatchObject({ problem: expect.stringContaining("built into cmd") });
    expect(check("test", undefined, "linux")).toMatchObject({ problem: expect.stringContaining("built into Bash") });
    expect(check("taken")).toMatchObject({ problem: expect.stringContaining("on the PATH already") });
    expect(check("1x")).toMatchObject({ problem: expect.stringContaining("starting with a letter") });
    expect(check("cw", "claude-cw")).toMatchObject({ problem: expect.stringContaining(".claude-<name>") });
    expect(check("cw", undefined, "win32", new Map())).toEqual({ ok: true });
    mkdirSync(join(home, ".claude-cw"));
    expect(check("cw", undefined, "win32", new Map())).toEqual({ reuse: join(home, ".claude-cw") });
    writeFileSync(join(home, ".claude-cw", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "jan@work.com" } }));
    expect(check("cw", undefined, "win32", new Map())).toMatchObject({ problem: ".claude-cw is the account of jan@work.com already" });
    writeFileSync(join(bin, "cx.cmd"), "");
    expect(check("cx", undefined, "win32", new Map())).toMatchObject({ problem: expect.stringContaining("exists already") });
    expect(commandOnPath("claude", bin)).toBeUndefined();
  });

  it("writes a cmd script and a Bash one on Windows, the Bash one elsewhere", () => {
    const [cmd, bash] = startScripts("cw", join(home, ".claude-cw"), bin, "win32", home);
    expect(cmd!.file).toBe(join(bin, "cw.cmd"));
    expect(cmd!.text).toContain('set "CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-cw"\r\ncall claude %*');
    expect(bash!.file).toBe(join(bin, "cw"));
    expect(bash!.text).toContain('export CLAUDE_CONFIG_DIR="$USERPROFILE\\.claude-cw"\nexec claude "$@"');
    const posix = startScripts("cw", join(home, ".claude-cw"), bin, "linux", home);
    expect(posix).toHaveLength(1);
    expect(posix[0]!.text).toContain('export CLAUDE_CONFIG_DIR="$HOME/.claude-cw"');
    writeAccountFiles("cw", join(home, ".claude-cw"), bin);
    expect(existsSync(join(home, ".claude-cw"))).toBe(true);
    expect(() => writeAccountFiles("cw", join(home, ".claude-cw"), bin)).toThrow();
  });

  it("asks PowerShell for its aliases, and has none to tell without it", async () => {
    expect((await powershellAliases())?.get("ll")).toBe("Get-ChildItem");
    aliasAnswer = undefined;
    expect(await powershellAliases()).toBeUndefined();
  });

  it("explains how to add one by hand and the names to avoid", () => {
    const text = addAccountLines(200, "win32").map(strip).join("\n");
    expect(text).toContain("cp runs Copy-Item, not cp.cmd");
    expect(text).toContain('set "CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-cw"');
    expect(text).toContain("cw plugin install cco@cc-outline");
  });

  it("sets one up from the Accounts view: checks, writes, prepares cco and opens a window to sign in", async () => {
    process.env.WT_SESSION = "x";
    // The folder is there with the plugin already, so nothing is installed; it is offered again.
    const folder = join(home, ".claude-cw");
    mkdirSync(join(folder, "plugins"), { recursive: true });
    writeFileSync(join(folder, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "cco@cc-outline": [{ scope: "user" }] } }));
    const own = join(home, ".claude");
    const state: AccountState = { accounts: [{ dir: own, file: join(own, ".claude.json"), email: "me@home.de" }], current: undefined, multiple: false, own };
    state.current = state.accounts[0];
    const view = renderInk(
      <AccountContext.Provider value={state}>
        <AccountsView cwd={home} layout={layout} visible active />
      </AccountContext.Provider>,
      layout,
      { wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider> },
    );
    await until(() => view.frame().includes("how to add an account"));
    await view.press("G");
    await view.press("\u001b[F");
    await until(() => view.frame().includes("↵ add an account…"));
    await view.press("\r");
    await until(() => view.frame().includes("Add an account"));
    // The name of a PowerShell alias (elsewhere: of a Bash builtin) is refused.
    const windows = process.platform === "win32";
    await view.press("\u0015");
    await view.press(windows ? "cp" : "test");
    await view.press("\r");
    await until(() => view.frame().includes(windows ? "cp is a PowerShell alias of Copy-Item" : "test is built into Bash"));
    await view.press("\u0015");
    await view.press("cw");
    await view.press("\r");
    await until(() => view.frame().includes("exists without an account: Enter uses it"));
    await view.press("\r");
    await until(() => view.frame().includes("Sign in there with /login"));
    const script = join(bin, process.platform === "win32" ? "cw.cmd" : "cw");
    expect(readFileSync(script, "utf8")).toContain("CLAUDE_CONFIG_DIR");
    const wt = spawned.find((c) => c.cmd === "wt")!;
    expect(wt.args.slice(-3)).toEqual(["cmd", "/k", script]);
    view.unmount();
  });
});
