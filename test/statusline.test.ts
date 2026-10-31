import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stripVTControlCharacters as strip } from "node:util";
import { claudeSettingsFile } from "../src/claudeSettings.js";
import { cliFile } from "../src/cliPath.js";
import { readMainSettings, updateSettings } from "../src/settings.js";
import { branchOf, gatherExtras, openTodos } from "../src/statusline/extras.js";
import { renderStatusLine, sampleInput, segmentText, shortDuration, type StatusInput } from "../src/statusline/render.js";
import {
  applyStatusLine,
  hasOwnStatusLine,
  isCcoStatusLine,
  readStatusLineState,
  repairStatusLine,
  statusLineCommand,
  syncedStatusLine,
  syncStatusLineSetting,
} from "../src/statusline/setup.js";
import { todosFile } from "../src/transcript/locate.js";
import { handleHook } from "../src/hook.js";
import { nextValue, SETTING_ROWS } from "../src/tui/SettingsView.js";

const INPUT: StatusInput = {
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  context_window: { used_percentage: 58 },
  cost: { total_cost_usd: 57.782, total_duration_ms: 80811298, total_lines_added: 10811, total_lines_removed: 1389 },
  rate_limits: {
    five_hour: { used_percentage: 70, resets_at: new Date(2026, 9, 31, 23, 50).getTime() / 1000 },
    seven_day: { used_percentage: 92, resets_at: new Date(2026, 10, 1, 19, 0).getTime() / 1000 },
  },
};

const plain = (lines: string[]) => lines.map(strip);

let saved: string | undefined;
let dir: string;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "cco-statusline-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

/** An installed cco: cli.json names its dist/cli.js, and statusline.js lies next to it. */
function install(): string {
  const dist = join(mkdtempSync(join(tmpdir(), "cco-install-")), "node_modules", "cc-outline", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "cli.js"), "");
  writeFileSync(join(dist, "statusline.js"), "");
  mkdirSync(join(dir, "cco"), { recursive: true });
  writeFileSync(cliFile(), JSON.stringify({ cli: join(dist, "cli.js") }));
  return join(dist, "statusline.js");
}

const writeClaude = (value: unknown) => writeFileSync(claudeSettingsFile(), JSON.stringify(value));
const readClaude = () => JSON.parse(readFileSync(claudeSettingsFile(), "utf8")) as Record<string, unknown>;
const OWN = { type: "command", command: "node C:/Users/me/.claude/statusline.mjs" };

describe("status line presets", () => {
  it("draws compact like the user's line: model, context and both windows with their reset", () => {
    expect(plain(renderStatusLine("compact", INPUT))).toEqual(["Opus 5.5 | ctx 58% | 5h 70% 23:50 | 7d 92% Sun 19:00"]);
  });

  it("colours the percentages green, yellow from 75 %, red from 90 %", () => {
    const [line] = renderStatusLine("compact", INPUT);
    expect(line).toContain("\u001b[32m58%");
    expect(line).toContain("\u001b[31m92%");
    expect(segmentText("context", { context_window: { used_percentage: 75 } }, {})).toContain("\u001b[33m75%");
  });

  it("gives detailed a second line with branch, cost, duration and lines", () => {
    expect(plain(renderStatusLine("detailed", INPUT, { branch: "main" }))[1]).toBe("⎇ main | $57.78 | ⏱ 22h26m | +10811 −1389");
  });

  it("puts the account in front and the open to-do items at the end for cco", () => {
    const [line] = renderStatusLine("cco", INPUT, { account: { label: "🦊", color: "magenta" }, todos: 3 });
    expect(line.startsWith("\u001b[45;97m 🦊 ")).toBe(true);
    expect(strip(line)).toBe(" 🦊  | Opus 5.5 | ctx 58% | 5h 70% 23:50 | 7d 92% Sun 19:00 | ☐ 3");
  });

  it("shows – for what Claude Code has not reported and leaves out what is missing", () => {
    expect(plain(renderStatusLine("detailed", {}))).toEqual(["ctx – | 5h – | 7d –"]);
    expect(plain(renderStatusLine("cco", { model: { display_name: "Opus 5.5" } }, { todos: 0 }))).toEqual(["Opus 5.5 | ctx – | 5h – | 7d –"]);
  });

  it("computes the context from the tokens without a percentage", () => {
    const input = { context_window: { context_window_size: 200000, current_usage: { input_tokens: 2, cache_creation_input_tokens: 1998, cache_read_input_tokens: 48000 } } };
    expect(strip(segmentText("context", input, {})!)).toBe("ctx 25%");
  });

  it("leaves out a segment that fails, keeping the line", () => {
    const broken = { ...INPUT, model: { get display_name(): string { throw new Error("bad"); } } } as StatusInput;
    expect(plain(renderStatusLine("minimal", broken))).toEqual(["ctx 58%"]);
  });

  it("writes durations short", () => {
    expect([shortDuration(20_000), shortDuration(12 * 60_000), shortDuration(3 * 3600_000 + 5 * 60_000)]).toEqual(["<1m", "12m", "3h05m"]);
  });

  it("has an example input for every preset", () => {
    expect(plain(renderStatusLine("compact", sampleInput()))[0]).toMatch(/^Opus 5\.5 \| ctx 42% \| 5h 23% \d\d:\d\d \| 7d 78% \w{3} \d\d:\d\d$/);
  });
});

describe("status line data from cco's files", () => {
  it("reads the branch from .git/HEAD, also of a worktree, and a short commit when detached", () => {
    const repo = mkdtempSync(join(tmpdir(), "cco-repo-"));
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    expect(branchOf(join(repo, "src", "deep"))).toBe("feature/x");
    const worktree = mkdtempSync(join(tmpdir(), "cco-worktree-"));
    const gitdir = join(repo, ".git", "worktrees", "w");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "0123456789abcdef\n");
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
    expect(branchOf(worktree)).toBe("0123456");
  });

  it("counts the open items of the project's to-do lists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cco-todo-project-"));
    mkdirSync(join(dir, "cco"), { recursive: true });
    writeFileSync(todosFile(cwd), JSON.stringify({ lists: [{ items: [{ status: "open" }, { status: "done" }, { status: "doing" }] }, { items: [{ status: "open" }] }] }));
    expect(openTodos(cwd)).toBe(3);
    expect(openTodos(mkdtempSync(join(tmpdir(), "cco-empty-")))).toBe(0);
  });

  it("reads only what the preset shows", () => {
    expect(gatherExtras("minimal", { cwd: "/nowhere" })).toEqual({ branch: undefined, account: undefined, todos: undefined });
  });

  it("names the account by its avatar, else its email's name, in its colour", () => {
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "jan@work.com" } }));
    expect(gatherExtras("cco", {}).account?.label).toBe("jan");
    updateSettings({ accountAvatar: "🦊", accountColor: "cyan" });
    expect(gatherExtras("cco", {}).account).toEqual({ label: "🦊", color: "cyan" });
    updateSettings({ accountColor: "off" });
    expect(gatherExtras("cco", {}).account).toEqual({ label: "🦊", color: undefined });
  });
});

describe("status line in Claude Code's settings.json", () => {
  it("recognises cco's command only", () => {
    expect(isCcoStatusLine(statusLineCommand("/usr/lib/node_modules/cc-outline/dist/statusline.js"))).toBe(true);
    expect(isCcoStatusLine(OWN.command)).toBe(false);
  });

  it("sets cco's command for a preset and keeps the rest of settings.json, with a backup", () => {
    const script = install();
    writeClaude({ model: "opus" });
    applyStatusLine("compact");
    expect(readClaude()).toEqual({ model: "opus", statusLine: { type: "command", command: statusLineCommand(script) } });
    expect(readFileSync(`${claudeSettingsFile()}.cco-backup`, "utf8")).toBe(JSON.stringify({ model: "opus" }));
    expect(readStatusLineState()).toMatchObject({ cco: true, stale: false });
  });

  it("remembers the user's own line, brings it back with own and unchanged, and removes it with off", () => {
    install();
    writeClaude({ statusLine: OWN });
    expect(hasOwnStatusLine()).toBe(true);
    applyStatusLine("cco");
    expect(readStatusLineState()).toMatchObject({ cco: true, own: OWN });
    applyStatusLine("own");
    expect(readClaude().statusLine).toEqual(OWN);
    applyStatusLine("off");
    expect(readClaude().statusLine).toBeUndefined();
    applyStatusLine("minimal");
    applyStatusLine("unchanged");
    expect(readClaude().statusLine).toEqual(OWN);
  });

  it("leaves a line of the user's own alone with unchanged, and has no own without one", () => {
    writeClaude({});
    expect(hasOwnStatusLine()).toBe(false);
    expect(() => applyStatusLine("own")).toThrow(/no status line of your own/);
    writeClaude({ statusLine: OWN });
    applyStatusLine("unchanged");
    expect(readClaude().statusLine).toEqual(OWN);
  });

  it("changes nothing in a settings.json that is no JSON", () => {
    writeFileSync(claudeSettingsFile(), "{ broken");
    expect(() => applyStatusLine("compact")).toThrow(/no valid JSON/);
    expect(readFileSync(claudeSettingsFile(), "utf8")).toBe("{ broken");
  });

  it("follows settings.json: another command is own, none is off, cco's keeps the preset", () => {
    install();
    writeClaude({ statusLine: OWN });
    expect(syncedStatusLine("compact")).toBe("own");
    expect(syncedStatusLine("unchanged")).toBe("unchanged");
    writeClaude({});
    expect(syncedStatusLine("cco")).toBe("off");
    applyStatusLine("detailed");
    expect(syncedStatusLine("detailed")).toBe("detailed");
    expect(syncedStatusLine("own")).toBe("compact");
    updateSettings({ statusLine: "minimal" });
    writeClaude({ statusLine: { type: "command", command: "echo hi" } });
    syncStatusLineSetting();
    expect(readMainSettings().statusLine).toBe("own");
    expect(readStatusLineState().own).toEqual({ type: "command", command: "echo hi" });
  });

  it("points a stale line at the installed cco, and never touches the user's own", () => {
    const script = install();
    writeClaude({ statusLine: { type: "command", command: statusLineCommand("/gone/dist/statusline.js"), padding: 1 } });
    expect(readStatusLineState().stale).toBe(true);
    expect(repairStatusLine()).toBe(true);
    expect(readClaude().statusLine).toEqual({ type: "command", command: statusLineCommand(script), padding: 1 });
    expect(repairStatusLine()).toBe(false);
    writeClaude({ statusLine: OWN });
    expect(repairStatusLine()).toBe(false);
    expect(readClaude().statusLine).toEqual(OWN);
  });

  it("is repaired and followed by the SessionStart hook", () => {
    const script = install();
    updateSettings({ statusLine: "cco" });
    writeClaude({ statusLine: { type: "command", command: statusLineCommand("/old/dist/statusline.js") } });
    const cwd = mkdtempSync(join(tmpdir(), "cco-hook-project-"));
    handleHook({ hook_event_name: "SessionStart", source: "startup", session_id: "s", transcript_path: join(cwd, "s.jsonl"), cwd }, () => "", undefined);
    expect(readClaude().statusLine).toEqual({ type: "command", command: statusLineCommand(script) });
    expect(readMainSettings().statusLine).toBe("cco");
  });
});

describe("status line setting", () => {
  const row = SETTING_ROWS.find((r) => r.key === "statusLine")!;

  it("skips own on Enter while none is remembered", () => {
    writeClaude({});
    expect(nextValue(row, "off")).toBe("minimal");
    writeClaude({ statusLine: OWN });
    expect(nextValue(row, "off")).toBe("own");
  });

  it("shows each preset as it looks below its meaning", () => {
    const lines = row.example!("compact", { now: new Date(), cwd: dir });
    expect(lines).toHaveLength(1);
    expect(strip(lines![0])).toMatch(/ctx \d+%/);
    expect(row.example!("off", { now: new Date(), cwd: dir })).toBeUndefined();
  });
});
