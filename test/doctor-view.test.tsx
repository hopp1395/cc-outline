import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { claudeDir, projectSlug } from "../src/transcript/locate.js";
import type { Layout } from "../src/tui/layout.js";
import { SettingsView } from "../src/tui/SettingsView.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";

const layout: Layout = { columns: 140, rows: 40, listWidth: 40, previewWidth: 97, bodyHeight: 36 };
const cwd = join(tmpdir(), "cco-doctor-view-project");
/** Not a multiple of 4, so never a Windows pid. */
const DEAD = 999999;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-doctor-view-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const renderView = (element: ReactElement) => renderInk(element, layout, { wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider> });

describe("doctor in the settings", () => {
  it("checks after Enter and a confirmation, then offers the repair and checks again", async () => {
    const stale = join(claudeDir(), "cco", `${projectSlug(cwd)}.claude-${DEAD}.json`);
    mkdirSync(join(claudeDir(), "cco"), { recursive: true });
    writeFileSync(stale, "{}");
    let modal = false;
    let wasModal = false;
    const onModal = (m: boolean) => {
      modal = m;
      wasModal ||= m;
    };
    const view = renderView(<SettingsView cwd={cwd} layout={layout} active select={{ key: "reset:doctor", at: 1 }} onModal={onModal} />);
    await expect.poll(view.frame).toContain("✚ Doctor");
    // Nothing is checked before Enter and the confirmation.
    expect(view.frame()).toContain("not checked yet");
    expect(view.frame()).toContain("↵ check");
    await view.press("\r");
    await expect.poll(view.frame).toContain("Run the doctor?");
    const confirmed = view.count();
    await view.press("\r");
    // Group by group, in a dialog; test/setup.ts drops the pauses, so the steps pass too fast to poll for.
    await expect.poll(view.frame, { timeout: 3000 }).toContain("1 state file of processes that have ended");
    expect(view.shown("Checking – Installation (1/5)…", confirmed)).toBe(true);
    expect(view.shown("Checking – Hooks (5/5)…", confirmed)).toBe(true);
    expect(view.shown("cannot be cancelled", confirmed)).toBe(true);
    expect(wasModal).toBe(true);
    expect(view.frame()).toContain("↵ repair");
    await view.press("\r");
    await expect.poll(view.frame).toContain("Repair 2 findings?");
    expect(modal).toBe(true);
    await view.press("\r");
    await expect.poll(() => existsSync(stale)).toBe(false);
    await expect.poll(view.frame, { timeout: 3000 }).toContain("nothing to clean up");
    expect(view.frame()).toContain("✓ delete 1 state file of ended processes");
    await expect.poll(() => modal, { timeout: 3000 }).toBe(false);
    view.unmount();
  });
});
