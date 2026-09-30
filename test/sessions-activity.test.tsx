import chalk from "chalk";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeDir, projectDir } from "../src/transcript/locate.js";
import type { Layout } from "../src/tui/layout.js";
import { SessionsView } from "../src/tui/SessionsView.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
const cwd = join(tmpdir(), "cco-activity-project");

let saved: string | undefined;
let level: typeof chalk.level;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-activity-"));
  mkdirSync(projectDir(cwd), { recursive: true });
  // With colours, so the list's marker shows its style.
  level = chalk.level;
  chalk.level = 1;
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
  chalk.level = level;
});

function renderView() {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: layout.columns, rows: layout.rows });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, ref: () => {}, unref: () => {} });
  const frames: string[] = [];
  stdout.on("data", (chunk) => {
    const text = String(chunk);
    if (stripAnsi(text).trim()) frames.push(text);
  });
  const app = render(<SessionsView cwd={cwd} layout={layout} visible active />, {
    stdout: stdout as never,
    stdin: stdin as never,
    debug: true,
    patchConsole: false,
  });
  const raw = () => frames.at(-1) ?? "";
  return { frames, raw, frame: () => stripAnsi(raw()), unmount: () => app.unmount() };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await tick();
}

function session(id: string, text: string) {
  const ts = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    join(projectDir(cwd), `${id}.jsonl`),
    JSON.stringify({ type: "user", uuid: `${id}-u`, timestamp: ts, cwd, message: { role: "user", content: text } }) + "\n",
  );
}

/** Registers the session as run by this process, with Claude Code's `status`. */
function running(id: string, status: string) {
  mkdirSync(join(claudeDir(), "sessions"), { recursive: true });
  writeFileSync(join(claudeDir(), "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, status }));
}

/** The list's marker of a running session, with the colour codes before it (the first `▶` of the row). */
const marker = (frame: string) =>
  frame
    .split("\n")
    .find((l) => l.includes("Some work"))
    ?.match(/(?:\u001b\[[0-9;]*m)+▶/)?.[0] ?? "";

describe("session activity", () => {
  it("blinks the marker while Claude works and names what it does in the header", async () => {
    session("s1", "Some work");
    running("s1", "busy");
    const view = renderView();
    await until(() => view.frame().includes("running elsewhere · working · claude --resume s1"));
    expect(view.frame()).toContain("running elsewhere · working · claude --resume s1");
    // Bright and dim in turn.
    await tick(1100);
    const seen = view.frames.map(marker).filter(Boolean);
    expect(seen.some((m) => m.includes("\u001b[2m"))).toBe(true);
    expect(seen.some((m) => !m.includes("\u001b[2m"))).toBe(true);

    running("s1", "waiting");
    await until(() => view.frame().includes("waiting for input"));
    expect(view.frame()).toContain("running elsewhere · waiting for input · claude --resume s1");
    expect(marker(view.raw())).toContain("\u001b[33m");

    running("s1", "idle");
    await until(() => view.frame().includes("running elsewhere · claude --resume s1"));
    expect(marker(view.raw())).toContain("\u001b[32m");
    expect(marker(view.raw())).not.toContain("\u001b[2m");
    view.unmount();
  });
});
