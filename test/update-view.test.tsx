import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, tick } from "./helpers/ink.js";
import { versionLabels, type Layout } from "../src/tui/layout.js";
import { repairProgress, SETTING_ROWS, SettingsView, updateProgress } from "../src/tui/SettingsView.js";
import { UpdateContext, type Update, type UpdateRun } from "../src/tui/useUpdate.js";
import { UPDATE_STEPS } from "../src/update.js";
import { VERSION } from "../src/version.js";
import { progressText, ProgressProvider } from "../src/tui/ProgressDialog.js";

const layout: Layout = { columns: 120, rows: 30, listWidth: 40, previewWidth: 77, bodyHeight: 26 };
const cwd = join(tmpdir(), "cco-update-project");

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-update-view-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const renderView = (element: ReactElement) => renderInk(element, layout, { wrap: (e) => <ProgressProvider layout={layout}>{e}</ProgressProvider> });

function fakeUpdate(overrides: Partial<Update> = {}): Update {
  return {
    releases: [
      { tag: "v9.9.9", version: "9.9.9", title: "v9.9.9", body: "### Chat\n\n- Brand new thing", date: "2026-09-28T10:00:00Z" },
      { tag: `v${VERSION}`, version: VERSION, title: `v${VERSION}`, body: "- What is installed" },
    ],
    latest: "9.9.9",
    checkedAt: Date.now(),
    stale: false,
    checking: false,
    mode: "on",
    offer: false,
    whatsNew: [],
    closeWhatsNew: () => {},
    install: "npm",
    root: "/usr/lib/node_modules/cc-outline",
    state: { kind: "update", target: "9.9.9" },
    recheck: async () => {},
    start: () => {},
    restart: () => false,
    open: () => {},
    ...overrides,
  };
}

describe("releases in the settings", () => {
  it("shows the update in the top bar and the notes of each release", async () => {
    const view = renderView(
      <UpdateContext.Provider value={fakeUpdate()}>
        <SettingsView cwd={cwd} layout={layout} active select={{ key: "releases", at: 1 }} />
      </UpdateContext.Provider>,
    );
    // The long status (the settings path) leaves room for the short form only; the status is cut, not the update.
    await expect.poll(view.frame, { timeout: 2000 }).toMatch(/… ↑ 9\.9\.9 *\n/);
    // /cco:releases selects the update, whose details show what is new.
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Update to v9.9.9");
    expect(view.frame()).toContain("npm install -g cc-outline@latest");
    expect(view.frame()).toContain("Brand new thing");
    expect(view.frame()).toContain("installed");
    await view.press("\u001b[B");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("2026-09-28 · new");
    await view.press("\u001b[B");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("What is installed");
    view.unmount();
  });

  it("asks before it updates", async () => {
    let started = 0;
    const view = renderView(
      <UpdateContext.Provider value={fakeUpdate({ start: () => started++ })}>
        <SettingsView cwd={cwd} layout={layout} active select={{ key: "update", at: 1 }} />
      </UpdateContext.Provider>,
    );
    await expect.poll(view.frame, { timeout: 2000 }).toContain("↵ update");
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Update cco to v9.9.9?");
    expect(started).toBe(0);
    await view.press("\r");
    await tick();
    expect(started).toBe(1);
    view.unmount();
  });

  it("asks at once when it is asked to (update: auto)", async () => {
    let started = 0;
    const view = renderView(
      <UpdateContext.Provider value={fakeUpdate({ mode: "auto", start: () => started++ })}>
        <SettingsView cwd={cwd} layout={layout} active select={{ key: "update", at: 1, ask: true }} />
      </UpdateContext.Provider>,
    );
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Update cco to v9.9.9?");
    // The dialog shows before its key handler is attached (slow CI runners): let the effects run first.
    await tick();
    await view.press("\r");
    await expect.poll(() => started, { timeout: 2000 }).toBe(1);
    view.unmount();
  });

  it("shows the steps of a failed update and the commands left", async () => {
    const [cli, marketplace, plugin] = [
      { label: "CLI", command: "npm install -g cc-outline@latest" },
      { label: "marketplace", command: "claude plugin marketplace update cc-outline" },
      { label: "plugin", command: "claude plugin update cco@cc-outline" },
    ];
    const run = {
      target: "9.9.9",
      status: "failed" as const,
      steps: [
        { step: cli, status: "done" as const, output: "" },
        { step: marketplace, status: "failed" as const, output: "\u001b[31mclaude: command not found\u001b[39m\n" },
        { step: plugin, status: "pending" as const, output: "" },
      ],
    };
    const view = renderView(
      <UpdateContext.Provider value={fakeUpdate({ run })}>
        <SettingsView cwd={cwd} layout={layout} active select={{ key: "update", at: 1 }} />
      </UpdateContext.Provider>,
    );
    await expect.poll(view.frame, { timeout: 2000 }).toContain("claude: command not found");
    expect(view.frame()).toContain("✗ marketplace");
    expect(view.frame()).toContain("The update stopped");
    expect(view.frame()).toContain("c copy commands");
    view.unmount();
  });

  it("shows a progress dialog from the confirmation until the restart", async () => {
    const [cli, marketplace, plugin] = UPDATE_STEPS;
    let run: UpdateRun | undefined;
    let modal = false;
    const element = () => (
      <UpdateContext.Provider value={fakeUpdate({ run, start: () => (run = { target: "9.9.9", status: "running", steps: [] }) })}>
        <SettingsView cwd={cwd} layout={layout} active select={{ key: "update", at: 1 }} onModal={(m) => (modal = m)} />
      </UpdateContext.Provider>
    );
    const view = renderView(element());
    await expect.poll(view.frame, { timeout: 2000 }).toContain("↵ update");
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Update cco to v9.9.9?");
    await view.press("\r");
    await tick();
    view.rerender(element());
    await expect.poll(view.frame, { timeout: 2000 }).toContain("cannot be cancelled");
    expect(view.frame()).toContain("Updating…");
    expect(modal).toBe(true);
    run = {
      target: "9.9.9",
      status: "running",
      steps: [
        { step: cli!, status: "done", output: "" },
        { step: marketplace!, status: "running", output: "" },
        { step: plugin!, status: "pending", output: "" },
      ],
    };
    view.rerender(element());
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Updating – marketplace (2/3)…");
    // Esc does not close it while it runs.
    await view.press("\u001b");
    await tick();
    expect(view.frame()).toContain("Updating – marketplace (2/3)…");
    run = { ...run, status: "done" };
    view.rerender(element());
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Restarting…");
    expect(view.frame()).toContain("Updated to v9.9.9");
    view.unmount();
  });

  it("keeps the dialog of a failed update open until Esc", async () => {
    const [cli, marketplace, plugin] = UPDATE_STEPS;
    let run: UpdateRun | undefined;
    let modal = false;
    const element = () => (
      <UpdateContext.Provider value={fakeUpdate({ run, start: () => (run = { target: "9.9.9", status: "running", steps: [] }) })}>
        <SettingsView cwd={cwd} layout={layout} active select={{ key: "update", at: 1 }} onModal={(m) => (modal = m)} />
      </UpdateContext.Provider>
    );
    const view = renderView(element());
    await expect.poll(view.frame, { timeout: 2000 }).toContain("↵ update");
    await view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Update cco to v9.9.9?");
    await view.press("\r");
    await tick();
    run = {
      target: "9.9.9",
      status: "failed",
      steps: [
        { step: cli!, status: "done", output: "" },
        { step: marketplace!, status: "failed", output: "claude: command not found\n" },
        { step: plugin!, status: "pending", output: "" },
      ],
    };
    view.rerender(element());
    await expect.poll(view.frame, { timeout: 2000 }).toContain("The update stopped at marketplace (2/3)");
    expect(view.frame()).toContain("Esc close");
    expect(view.frame()).toContain("c copy commands");
    await view.press("\u001b");
    await expect.poll(view.frame, { timeout: 2000 }).not.toContain("Esc close");
    await expect.poll(() => modal, { timeout: 2000 }).toBe(false);
    // The details behind it still show what failed.
    expect(view.frame()).toContain("The update stopped. Run the rest by hand");
    view.unmount();
  });

  it("offers no update for a checkout run through npm link", async () => {
    const view = renderView(
      <UpdateContext.Provider value={fakeUpdate({ install: "dev", root: "C:\\Workspace\\cc-outline", state: { kind: "dev", target: "9.9.9" } })}>
        <SettingsView cwd={cwd} layout={layout} active select={{ key: "update", at: 1 }} />
      </UpdateContext.Provider>,
    );
    await expect.poll(view.frame, { timeout: 2000 }).toContain("development install");
    expect(view.frame()).not.toContain("↵ update");
    expect(view.frame()).not.toContain("↑ 9.9.9");
    view.unmount();
  });

  it("lists a note while no releases are known", async () => {
    const view = renderView(
      <UpdateContext.Provider value={fakeUpdate({ releases: [], latest: undefined, state: { kind: "none" }, mode: "off", checkedAt: undefined })}>
        <SettingsView cwd={cwd} layout={layout} active select={{ key: "releases", at: 1 }} />
      </UpdateContext.Provider>,
    );
    await expect.poll(view.frame, { timeout: 2000 }).toContain("The update check is off");
    expect(SETTING_ROWS.some((r) => r.key === "updateMode")).toBe(true);
    view.unmount();
  });
});

describe("progress dialogs", () => {
  const step = (label: string, status: "pending" | "running" | "done" | "failed", output = "") => ({ step: { label }, status, output });

  it("says that the viewer cannot reopen itself after an update", () => {
    const run: UpdateRun = { target: "9.9.9", status: "done", steps: [], reopenFailed: true };
    const progress = updateProgress(run, () => {});
    expect(progress.status).toBe("done");
    expect(progress.lines?.join(" ")).toContain("close it with q");
  });

  it("names the repairs that failed", () => {
    const progress = repairProgress({ status: "failed", results: [step("a", "failed", "boom\n"),step("b", "done"), step("c", "failed", "")] });
    expect(progress.text).toBe("2 of 3 repairs failed");
    expect(progress.lines).toEqual(["a:", "  boom", "c:", "The report shows what is left."]);
    expect(progressText(repairProgress({ status: "running", results: [step("a", "done"), step("b", "running")] }))).toBe("Repairing – b (2/2)…");
    expect(progress.copy).toBeUndefined();
  });
});

describe("versionLabels", () => {
  it("names the update in full and in short", () => {
    expect(versionLabels({ kind: "update", target: "9.9.9" })).toEqual({ full: ` v${VERSION} → 9.9.9 `, short: " ↑ 9.9.9 " });
    expect(versionLabels({ kind: "restart", target: "9.9.9" }).full).toBe(" ↻ 9.9.9 ");
    expect(versionLabels({ kind: "dev", target: "9.9.9" })).toEqual({ full: ` v${VERSION} ` });
  });
});
