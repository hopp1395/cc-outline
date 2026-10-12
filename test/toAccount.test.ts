import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Account } from "../src/account.js";
import { continueInAccount, matchAccount, otherAccounts } from "../src/accountContinue.js";
import { marketplaceSource, pluginState, pluginSteps, prepareAccount } from "../src/accountSetup.js";
import { copyToAccount } from "../src/export/toAccount.js";
import { readFavorites, toggleFavorite } from "../src/favorites.js";
import { resumeShellCommand } from "../src/open.js";
import { cliFile } from "../src/cliPath.js";
import { settingsFile } from "../src/settings.js";
import { claudeDir, inClaudeDir, projectDir, projectSlug, withClaudeDir, writeJson } from "../src/transcript/locate.js";
import type { SessionSummary } from "../src/transcript/sessions.js";
import { readTransfers, recordTransfer } from "../src/transfers.js";

const line = (entry: object) => JSON.stringify(entry) + "\n";
const put = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};
const cwd = join(tmpdir(), "cco-account-project");
let saved: string | undefined;
let a: string;
let b: string;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  a = mkdtempSync(join(tmpdir(), "cco-account-a-"));
  b = mkdtempSync(join(tmpdir(), "cco-account-b-"));
  process.env.CLAUDE_CONFIG_DIR = a;
  mkdirSync(projectDir(cwd), { recursive: true });
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

/** A session whose transcript names a file of its own config folder (a tool result), with file history. */
function writeSession(id: string): SessionSummary {
  const path = join(projectDir(cwd), `${id}.jsonl`);
  const result = join(a, "projects", projectSlug(cwd), id, "tool-results", "r1.txt");
  writeFileSync(
    path,
    line({ type: "user", uuid: "u1", sessionId: id, cwd, timestamp: "2026-10-12T08:00:00.000Z", message: { role: "user", content: "hello" } }) +
      line({ type: "assistant", uuid: "a1", sessionId: id, cwd, timestamp: "2026-10-12T08:00:05.000Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: `saved to ${result}` }], stop_reason: "end_turn" } }),
  );
  mkdirSync(join(a, "projects", projectSlug(cwd), id, "tool-results"), { recursive: true });
  writeFileSync(result, "output");
  mkdirSync(join(a, "file-history", id), { recursive: true });
  writeFileSync(join(a, "file-history", id, "f@v1"), "old content");
  return { id, path, cwd, prompts: [{ text: "hello", timestamp: "2026-10-12T08:00:00.000Z" }], plans: [], files: [], start: "2026-10-12T08:00:00.000Z" } as unknown as SessionSummary;
}

describe("copyToAccount", () => {
  it("copies the session into the other config folder with its paths rewritten, keeping the ids and the original", () => {
    const s = writeSession("s-1");
    toggleFavorite(cwd, "sessions", "s-1");
    const copy = copyToAccount(s, b);
    expect(copy.id).toBe("s-1");
    expect(copy.path).toBe(join(b, "projects", projectSlug(cwd), "s-1.jsonl"));
    const text = readFileSync(copy.path, "utf8");
    expect(text).toContain(JSON.stringify(join(b, "projects", projectSlug(cwd), "s-1", "tool-results", "r1.txt")).slice(1, -1));
    expect(text).not.toContain(JSON.stringify(a).slice(1, -1));
    expect(readFileSync(join(b, "projects", projectSlug(cwd), "s-1", "tool-results", "r1.txt"), "utf8")).toBe("output");
    expect(readFileSync(join(b, "file-history", "s-1", "f@v1"), "utf8")).toBe("old content");
    // The original stays, and the mark goes along into the other account's cco data.
    expect(existsSync(s.path)).toBe(true);
    expect(inClaudeDir(b, () => readFavorites(cwd, "sessions"))).toEqual(["s-1"]);
  });

  it("gives the copy new ids when the other account has the session already", () => {
    const s = writeSession("s-2");
    copyToAccount(s, b);
    const again = copyToAccount(s, b);
    expect(again.id).not.toBe("s-2");
    expect(again.ids.get("s-2")).toBe(again.id);
    const text = readFileSync(again.path, "utf8");
    expect(text).toContain(`"sessionId":"${again.id}"`);
    expect(existsSync(join(b, "file-history", again.id, "f@v1"))).toBe(true);
  });

  it("refuses to copy into its own folder", () => {
    expect(() => copyToAccount(writeSession("s-3"), a)).toThrow(/already/);
  });
});

describe("continueInAccount", () => {
  it("copies the session there and notes it on both sides, with nothing to install", async () => {
    put(join(b, "plugins", "installed_plugins.json"), { plugins: { "cco@cc-outline": [{ scope: "user" }] } });
    const s = writeSession("s-4");
    const reports: string[][] = [];
    const result = await continueInAccount({ session: s, account: { dir: b, file: "", email: "b@x" }, fromEmail: "a@x" }, (steps) =>
      reports.push(steps.map((r) => `${r.step.label}:${r.status}`)),
    );
    expect(result.kind).toBe("done");
    expect(reports.at(-1)).toEqual(["copying the session:done"]);
    expect(existsSync(join(b, "projects", projectSlug(cwd), "s-4.jsonl"))).toBe(true);
    expect(readTransfers(cwd)["s-4"]?.to?.[0]).toMatchObject({ dir: b, email: "b@x", id: "s-4" });
    expect(inClaudeDir(b, () => readTransfers(cwd))["s-4"]?.from).toMatchObject({ dir: a, email: "a@x", id: "s-4" });
  });
});

describe("transfers", () => {
  it("records the move on both sides", () => {
    recordTransfer(cwd, { dir: a, email: "a@x", id: "old" }, { dir: b, email: "b@x", id: "new" }, 1000);
    expect(readTransfers(cwd)).toEqual({ old: { to: [{ dir: b, email: "b@x", id: "new", at: 1000 }] } });
    expect(inClaudeDir(b, () => readTransfers(cwd))).toEqual({ new: { from: { dir: a, email: "a@x", id: "old", at: 1000 } } });
    expect(claudeDir()).toBe(a);
  });
});

describe("the other account's setup", () => {
  it("installs the plugin from the marketplace source this account uses, or only enables it", () => {
    put(join(a, "plugins", "known_marketplaces.json"), { "cc-outline": { source: { source: "directory", path: "C:\\npm\\node_modules\\cc-outline" } } });
    expect(marketplaceSource()).toBe("C:\\npm\\node_modules\\cc-outline");
    expect(pluginSteps(b).map((s) => s.command)).toEqual(["claude plugin marketplace add C:\\npm\\node_modules\\cc-outline", "claude plugin install cco@cc-outline"]);
    put(join(b, "plugins", "installed_plugins.json"), { plugins: { "cco@cc-outline": [{ scope: "user" }] } });
    put(join(b, "settings.json"), { enabledPlugins: { "cco@cc-outline": false } });
    expect(pluginState(b)).toEqual({ marketplace: false, installed: true, enabled: false });
    expect(pluginSteps(b).map((s) => s.command)).toEqual(["claude plugin enable cco@cc-outline"]);
    put(join(b, "settings.json"), { enabledPlugins: { "cco@cc-outline": true } });
    expect(pluginSteps(b)).toEqual([]);
  });

  it("takes over the CLI path and the settings, without the account colour, only where there are none", () => {
    writeJson(cliFile(), { cli: "/x/cli.js" });
    writeJson(settingsFile(), { showTools: "full", accountColor: "red" });
    prepareAccount(b);
    expect(JSON.parse(readFileSync(join(b, "cco", "cli.json"), "utf8"))).toEqual({ cli: "/x/cli.js" });
    expect(JSON.parse(readFileSync(join(b, "cco", "settings.json"), "utf8"))).toEqual({ showTools: "full" });
    writeJson(settingsFile(), { showTools: "off" });
    prepareAccount(b);
    expect(JSON.parse(readFileSync(join(b, "cco", "settings.json"), "utf8"))).toEqual({ showTools: "full" });
  });
});

describe("accounts", () => {
  const account = (dir: string, email: string): Account => ({ dir, file: join(dir, ".claude.json"), email });
  const accounts = [account("/h/.claude", "me@home.de"), account("/h/.claude-work", "jan@work.com"), account("/h/.claude-test", "test@work.com")];

  it("leaves out this viewer's own account", () => {
    expect(otherAccounts(accounts, "/h/.claude").map((x) => x.email)).toEqual(["jan@work.com", "test@work.com"]);
  });

  it("finds the account named by email, folder, folder suffix or a unique part", () => {
    expect(matchAccount(accounts, "JAN@work.com")?.dir).toBe("/h/.claude-work");
    expect(matchAccount(accounts, ".claude-test")?.email).toBe("test@work.com");
    expect(matchAccount(accounts, "work")?.email).toBe("jan@work.com");
    expect(matchAccount(accounts, "home")?.email).toBe("me@home.de");
    expect(matchAccount(accounts, "@work")).toBeUndefined();
    expect(matchAccount(accounts, "")).toBeUndefined();
  });

  it("starts Claude Code under the other folder, or without CLAUDE_CONFIG_DIR for the default one", () => {
    expect(withClaudeDir({ claude_config_dir: "/x", PATH: "p" }, "/h/.claude-work")).toEqual({ PATH: "p", CLAUDE_CONFIG_DIR: "/h/.claude-work" });
    expect(withClaudeDir({ CLAUDE_CONFIG_DIR: "/x" }, join(homedir(), ".claude"))).toEqual({});
    expect(resumeShellCommand("id1", "/h/.claude-work", "linux")).toBe("CLAUDE_CONFIG_DIR='/h/.claude-work' claude --resume id1");
    expect(resumeShellCommand("id1", "C:\\h\\.claude-work", "win32")).toBe('set "CLAUDE_CONFIG_DIR=C:\\h\\.claude-work" && claude --resume id1');
    expect(resumeShellCommand("id1")).toBe("claude --resume id1");
    // A folder in the home folder is named through its variable.
    const home = join(tmpdir(), "cco-home");
    expect(resumeShellCommand("id1", join(home, ".claude-work"), "win32", false, home)).toBe('set "CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-work" && claude --resume id1');
    expect(resumeShellCommand("id1", join(home, ".claude-work"), "linux", false, home)).toBe('CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude --resume id1');
  });
});
