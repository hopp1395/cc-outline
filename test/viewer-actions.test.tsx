import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "../src/settings.js";
import { App } from "../src/tui/App.js";

let saved: string | undefined;
const asked: string[] = [];
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-actions-"));
  asked.length = 0;
  vi.stubGlobal("fetch", (url: string) => {
    asked.push(url);
    return Promise.reject(new Error("no network in tests"));
  });
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("/cco:update", () => {
  it("checks for an update at once, even with the update check off, and shows Settings", async () => {
    updateSettings({ updateMode: "off" });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 160, rows: 24 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, ref: () => {}, unref: () => {} });
    let frame = "";
    stdout.on("data", (chunk) => {
      const text = stripAnsi(String(chunk));
      if (text.trim()) frame = text;
    });
    const project = mkdtempSync(join(tmpdir(), "cco-actions-app-"));
    const app = render(<App cwd={project} sessionId="none" initialMode="chat" action="update" />, {
      stdout: stdout as never,
      stdin: stdin as never,
      debug: true,
      patchConsole: false,
    });
    await expect.poll(() => frame, { timeout: 2000 }).toContain("settings.json");
    await expect.poll(() => asked.some((u) => u.includes("registry.npmjs.org")), { timeout: 2000 }).toBe(true);
    app.unmount();
  });
});
