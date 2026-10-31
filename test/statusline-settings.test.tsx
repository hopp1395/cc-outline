import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { claudeSettingsFile } from "../src/claudeSettings.js";
import { cliFile } from "../src/cliPath.js";
import { readSettings } from "../src/settings.js";
import { statusLineCommand } from "../src/statusline/setup.js";
import type { Layout } from "../src/tui/layout.js";
import { SettingsView } from "../src/tui/SettingsView.js";

const layout: Layout = { columns: 140, rows: 40, listWidth: 40, previewWidth: 97, bodyHeight: 36 };
const cwd = join(tmpdir(), "cco-statusline-project");
const OWN = { type: "command", command: "node own.mjs" };

let saved: string | undefined;
let script: string;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-statusline-view-"));
  const dist = join(mkdtempSync(join(tmpdir(), "cco-install-")), "dist");
  mkdirSync(dist, { recursive: true });
  script = join(dist, "statusline.js");
  writeFileSync(script, "");
  mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, "cco"), { recursive: true });
  writeFileSync(cliFile(), JSON.stringify({ cli: join(dist, "cli.js") }));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const statusLine = () => (JSON.parse(readFileSync(claudeSettingsFile(), "utf8")) as { statusLine?: unknown }).statusLine;

describe("status line in the Settings view", () => {
  it("writes cco's status line with Enter and brings the own one back", async () => {
    writeFileSync(claudeSettingsFile(), JSON.stringify({ statusLine: OWN }));
    const view = renderInk(<SettingsView cwd={cwd} layout={layout} active select={{ key: "statusLine", at: 1 }} />, layout);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Claude Code: status line");
    // Never chosen: a line of one's own stays as it is, and unchanged with it.
    await expect.poll(() => readSettings().statusLine, { timeout: 2000 }).toBe("unchanged");
    await view.press("\r");
    await expect.poll(() => readSettings().statusLine, { timeout: 2000 }).toBe("off");
    expect(statusLine()).toBeUndefined();
    await view.press("\r");
    await expect.poll(() => readSettings().statusLine, { timeout: 2000 }).toBe("own");
    expect(statusLine()).toEqual(OWN);
    await view.press("\r");
    await expect.poll(() => readSettings().statusLine, { timeout: 2000 }).toBe("minimal");
    expect(statusLine()).toEqual({ type: "command", command: statusLineCommand(script) });
    await expect.poll(view.frame, { timeout: 2000 }).toContain("your own: node own.mjs");
    view.unmount();
  });

  it("says so and keeps the value when settings.json is no JSON", async () => {
    writeFileSync(claudeSettingsFile(), "{ broken");
    const view = renderInk(<SettingsView cwd={cwd} layout={layout} active select={{ key: "statusLine", at: 1 }} />, layout);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Claude Code: status line");
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("no valid JSON");
    expect(readSettings().statusLine).toBe("unchanged");
    view.unmount();
  });
});
