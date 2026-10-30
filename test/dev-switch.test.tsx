import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Box } from "ink";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { cliFile } from "../src/cliPath.js";
import { writeJson } from "../src/transcript/locate.js";
import { DevSwitchDialog, switchProgress } from "../src/tui/DevSwitchDialog.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";
import { UPDATE_STEPS, type StepResult } from "../src/update.js";

const layout: Layout = { columns: 90, rows: 24, listWidth: 30, previewWidth: 57, bodyHeight: 22 };

const saved = process.env.CLAUDE_CONFIG_DIR;
let dir: string;
let checkout: string;
let global: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cco-dev-"));
  process.env.CLAUDE_CONFIG_DIR = join(dir, ".claude");
  checkout = join(dir, "checkout");
  global = join(dir, "npm", "node_modules", "cc-outline");
  mkdirSync(checkout);
  mkdirSync(dirname(global), { recursive: true });
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const render = (onClose: () => void) =>
  renderInk(
    <ProgressProvider layout={layout}>
      <Box width={layout.columns} height={layout.rows}>
        <DevSwitchDialog layout={layout} root={checkout} onRestart={() => true} onClose={onClose} />
      </Box>
    </ProgressProvider>,
    layout,
  );

describe("DevSwitchDialog", () => {
  it("asks before installing the release in place of a linked checkout; Esc leaves it", async () => {
    symlinkSync(checkout, global, "junction");
    writeJson(cliFile(), { cli: join(global, "dist", "cli.js") });
    let closed = 0;
    const view = render(() => closed++);
    await expect.poll(() => view.frame()).toContain("Switch to the release of cco?");
    expect(view.frame()).toContain("npm install -g cc-outline@latest");
    expect(view.frame()).toContain("npm link there switches back");
    await view.press("\u001b");
    await expect.poll(() => closed).toBe(1);
    view.unmount();
  });

  it("says there is nothing to switch for a checkout run directly", async () => {
    let closed = 0;
    const view = render(() => closed++);
    await expect.poll(() => view.frame()).toContain("Runs from a checkout");
    expect(view.frame()).toContain("Development version");
    await view.press("\u001b");
    await expect.poll(() => closed).toBe(1);
    view.unmount();
  });
});

describe("switchProgress", () => {
  const steps = (status: StepResult["status"]): StepResult[] => UPDATE_STEPS.map((step, i) => ({ step, status: i === 0 ? status : "pending", output: i === 0 ? "EACCES" : "" }));

  it("shows the step running, where it stopped with what is left, then the restart", () => {
    expect(switchProgress({ status: "running", steps: steps("running") }, "", () => {})).toMatchObject({ status: "running", step: { label: "CLI", at: 1, of: 3 } });
    const failed = switchProgress({ status: "failed", steps: steps("failed") }, "", () => {});
    expect(failed.status).toBe("failed");
    expect(failed.lines).toContain("  npm install -g cc-outline@latest");
    expect(switchProgress({ status: "done", steps: steps("done") }, "", () => {})).toMatchObject({ status: "waiting", text: "Restarting" });
    expect(switchProgress({ status: "done", steps: steps("done"), reopenFailed: true }, "close it", () => {}).lines).toEqual(["close it", "Restart Claude Code for the plugin."]);
  });
});
