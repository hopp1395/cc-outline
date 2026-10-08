import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { App } from "../src/tui/App.js";
import { emitCtrlC } from "../src/tui/ctrlC.js";
import type { Layout } from "../src/tui/layout.js";
import { ProgressProvider } from "../src/tui/ProgressDialog.js";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-ctrl-c-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const layout: Layout = { columns: 140, rows: 40, listWidth: 40, previewWidth: 97, bodyHeight: 36 };

it("does not quit on Ctrl+C but says how to", async () => {
  const view = renderInk(<App cwd={mkdtempSync(join(tmpdir(), "cco-ctrl-c-app-"))} initialMode="settings" />, layout, {
    wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider>,
  });
  await expect.poll(view.frame).toContain("auto open");
  emitCtrlC();
  await expect.poll(view.frame).toContain("Ctrl+C does not quit: q does");
  expect(view.frame()).toContain("auto open");
  view.unmount();
});
