import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInk } from "./helpers/ink.js";
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
    const project = mkdtempSync(join(tmpdir(), "cco-actions-app-"));
    const app = renderInk(<App cwd={project} sessionId="none" initialMode="chat" action="update" />, { columns: 160, rows: 24 });
    await expect.poll(app.frame, { timeout: 2000 }).toContain("auto open");
    await expect.poll(() => asked.some((u) => u.includes("registry.npmjs.org")), { timeout: 2000 }).toBe(true);
    app.unmount();
  });
});
