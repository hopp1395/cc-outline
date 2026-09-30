import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import type { ReactElement } from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { versionLabels, type Layout } from "../src/tui/layout.js";
import { SETTING_ROWS, SettingsView } from "../src/tui/SettingsView.js";
import { UpdateContext, type Update } from "../src/tui/useUpdate.js";
import { VERSION } from "../src/version.js";

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

function renderView(element: ReactElement) {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: layout.columns, rows: layout.rows });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  stdout.on("data", (chunk) => {
    const text = stripAnsi(String(chunk));
    if (text.trim()) frame = text;
  });
  const app = render(element, { stdout: stdout as never, stdin: stdin as never, debug: true, patchConsole: false });
  return { frame: () => frame, press: (keys: string) => stdin.write(keys), unmount: () => app.unmount() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

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
    restart: () => {},
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
    view.press("\u001b[B");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("2026-09-28 · new");
    view.press("\u001b[B");
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
    view.press("\r");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Update cco to v9.9.9?");
    expect(started).toBe(0);
    view.press("\r");
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
    view.press("\r");
    await tick();
    expect(started).toBe(1);
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

describe("versionLabels", () => {
  it("names the update in full and in short", () => {
    expect(versionLabels({ kind: "update", target: "9.9.9" })).toEqual({ full: ` v${VERSION} → 9.9.9 `, short: " ↑ 9.9.9 " });
    expect(versionLabels({ kind: "restart", target: "9.9.9" }).full).toBe(" ↻ 9.9.9 ");
    expect(versionLabels({ kind: "dev", target: "9.9.9" })).toEqual({ full: ` v${VERSION} ` });
  });
});
