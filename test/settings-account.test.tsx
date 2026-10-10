import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { ACCOUNT_COLORS, type Account } from "../src/account.js";
import { DEFAULT_SETTINGS, readSettings, settingsFile } from "../src/settings.js";
import type { Layout } from "../src/tui/layout.js";
import { SETTING_ROWS, SettingsView, settingsEntries } from "../src/tui/SettingsView.js";
import { AccountContext, type AccountState } from "../src/tui/useAccount.js";

const layout: Layout = { columns: 130, rows: 40, listWidth: 44, previewWidth: 82, bodyHeight: 36 };
const cwd = join(tmpdir(), "cco-settings-account-project");
const update = { state: { kind: "none" }, releases: [], root: undefined } as never;

const account = (name: string, email: string): Account => ({ dir: join(tmpdir(), name), file: join(tmpdir(), name, ".claude.json"), email, organization: "Acme", name: "Jan" });

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-settings-account-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("Account group in the settings", () => {
  it("has the two settings, automatic and on by default", () => {
    const keys = SETTING_ROWS.filter((r) => r.group === "Account").map((r) => r.key);
    expect(keys).toEqual(["accountColor", "accountTitle"]);
    expect(DEFAULT_SETTINGS).toMatchObject({ accountTitle: true, accountColor: "auto" });
  });

  it("lists one entry per account, the details after the group's settings", () => {
    const work = account(".claude-work", "work@example.com");
    const me = account(".claude-personal", "me@example.com");
    const state: AccountState = { accounts: [me, work], current: me, multiple: true, own: me.dir };
    const names = settingsEntries(update, state).map((e) => ("key" in e ? e.key : "account" in e ? (`account:${"dir" in e ? e.dir : e.account}` as string) : "other"));
    const at = names.indexOf(`account:${me.dir}`);
    expect(names.slice(at - 1, at + 5)).toEqual(["updateMode", `account:${me.dir}`, `account:${work.dir}`, "accountColor", "accountTitle", "account:details"]);
  });

  it("reads the former on/off setting accountBadge as the colour off", () => {
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "cco"), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ accountBadge: false }));
    expect(readSettings().accountColor).toBe("off");
    writeFileSync(settingsFile(), JSON.stringify({ accountBadge: false, accountColor: "pink" }));
    expect(readSettings().accountColor).toBe("pink");
    writeFileSync(settingsFile(), JSON.stringify({ accountBadge: true }));
    expect(readSettings().accountColor).toBe("auto");
  });

  it("keeps an entry while no account is found", () => {
    const state: AccountState = { accounts: [], multiple: false, own: "" };
    expect(settingsEntries(update, state).some((e) => "account" in e && e.account === "none")).toBe(true);
  });

  it("shows the accounts in the list under their own separator", async () => {
    const work = account(".claude-work", "work@example.com");
    const me = account(".claude-personal", "me@example.com");
    const state: AccountState = { accounts: [me, work], current: me, multiple: true, own: me.dir, color: ACCOUNT_COLORS.teal };
    const app = renderInk(
      <AccountContext.Provider value={state}>
        <SettingsView cwd={cwd} layout={layout} active={false} />
      </AccountContext.Provider>,
      layout,
    );
    await expect.poll(app.frame, { timeout: 2000 }).toContain("── Account");
    const frame = app.frame();
    // The active account is marked, the other one is not; the folder tells them apart.
    expect(frame).toContain("● me@example.com (.claude-personal)");
    expect(frame).toContain("○ work@example.com (.claude-work)");
    expect(frame).toContain("how accounts are found");
    app.unmount();
  });

  it("explains what shows with a single account, and writes no setting by looking", async () => {
    const me = account(".claude-personal", "me@example.com");
    const state: AccountState = { accounts: [me], current: me, multiple: false, own: me.dir };
    const app = renderInk(
      <AccountContext.Provider value={state}>
        <SettingsView cwd={cwd} layout={layout} active={false} select={{ key: `account:${me.dir}`, at: 1 }} />
      </AccountContext.Provider>,
      layout,
    );
    await expect.poll(app.frame, { timeout: 2000 }).toContain("The colour shows in the top bar");
    expect(app.frame()).toContain("Acme");
    expect(app.frame()).toContain("active: the account of the Claude Code");
    app.unmount();
    expect(readSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
