import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { accountColorName, type Account } from "../src/account.js";
import { DEFAULT_SETTINGS, readSettings, settingsFile } from "../src/settings.js";
import type { Layout } from "../src/tui/layout.js";
import { SETTING_ROWS, settingLines, SettingsView, settingsEntries } from "../src/tui/SettingsView.js";
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
  it("has the account's settings, automatic, without an avatar and on by default", () => {
    const keys = SETTING_ROWS.filter((r) => r.group === "Account").map((r) => r.key);
    expect(keys).toEqual(["accountColor", "accountAvatar", "accountTitle", "viewAccounts", "accountsListWidth", "accountsOrder"]);
    expect(DEFAULT_SETTINGS).toMatchObject({ accountTitle: true, accountColor: "auto", accountAvatar: "" });
  });

  it("lists one entry per account, the details after the group's settings", () => {
    const work = account(".claude-work", "work@example.com");
    const me = account(".claude-personal", "me@example.com");
    const state: AccountState = { accounts: [me, work], current: me, multiple: true, own: me.dir };
    const names = settingsEntries(update, state).map((e) => ("key" in e ? e.key : "account" in e ? (`account:${"dir" in e ? e.dir : e.account}` as string) : "other"));
    const at = names.indexOf(`account:${me.dir}`);
    expect(names.slice(at - 1, at + 9)).toEqual(["updateMode", `account:${me.dir}`, `account:${work.dir}`, "accountColor", "accountAvatar", "accountTitle", "viewAccounts", "accountsListWidth", "accountsOrder", "account:details"]);
  });

  it("reads the former on/off setting accountBadge as the colour off", () => {
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "cco"), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ accountBadge: false }));
    expect(readSettings().accountColor).toBe("off");
    writeFileSync(settingsFile(), JSON.stringify({ accountBadge: false, accountColor: "magentaBright" }));
    expect(readSettings().accountColor).toBe("magentaBright");
    writeFileSync(settingsFile(), JSON.stringify({ accountBadge: true }));
    expect(readSettings().accountColor).toBe("auto");
  });

  it("takes the colours before the console's 16 back to auto", () => {
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "cco"), { recursive: true });
    for (const old of ["teal", "amber", "orange", "pink", "purple", "indigo"]) {
      writeFileSync(settingsFile(), JSON.stringify({ accountColor: old }));
      expect(readSettings().accountColor).toBe("auto");
    }
    writeFileSync(settingsFile(), JSON.stringify({ accountColor: "red" }));
    expect(readSettings().accountColor).toBe("red");
  });

  it("keeps an avatar of up to six columns, trimmed, and drops any other value", () => {
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "cco"), { recursive: true });
    for (const kept of ["🦊", "👾👾👾", "(^_^)", "JH", "=^.^="]) {
      writeFileSync(settingsFile(), JSON.stringify({ accountAvatar: kept }));
      expect(readSettings().accountAvatar).toBe(kept);
    }
    for (const dropped of [" JH ", "1234567", "🦊🦊🦊🦊", "a\u0007b", 3]) {
      writeFileSync(settingsFile(), JSON.stringify({ accountAvatar: dropped }));
      expect(readSettings().accountAvatar).toBe("");
    }
  });

  it("shows another account's avatar (read from its folder) in place of the colour's name", async () => {
    const work = account(".claude-work", "work@example.com");
    const me = account(".claude-personal", "me@example.com");
    const state: AccountState = { accounts: [me, { ...work, avatar: "🐙" }], current: me, multiple: true, own: me.dir };
    const app = renderInk(
      <AccountContext.Provider value={state}>
        <SettingsView cwd={cwd} layout={layout} active={false} />
      </AccountContext.Provider>,
      layout,
    );
    await expect.poll(app.frame, { timeout: 2000 }).toContain("── Account");
    expect(app.frame()).toContain(" 🐙 ");
    expect(app.frame()).toContain(` ${accountColorName("me@example.com")} `);
    app.unmount();
  });

  it("keeps an entry while no account is found", () => {
    const state: AccountState = { accounts: [], multiple: false, own: "" };
    expect(settingsEntries(update, state).some((e) => "account" in e && e.account === "none")).toBe(true);
  });

  it("shows the accounts in the list under their own separator", async () => {
    const work = account(".claude-work", "work@example.com");
    const me = account(".claude-personal", "me@example.com");
    const state: AccountState = { accounts: [me, work], current: me, multiple: true, own: me.dir, color: "cyan" };
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
    // The colour badge may cut the label.
    expect(frame).toContain("○ work@example.com (.claude-w");
    expect(frame).toContain("how accounts are found");
    // The colour name at the right end, as a badge with a space on each side.
    expect(frame).toContain(` ${accountColorName("me@example.com")} `);
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
    await expect.poll(app.frame, { timeout: 2000 }).toContain("The colour and the avatar show in the top bar");
    expect(app.frame()).toContain("Acme");
    expect(app.frame()).toContain("active: the account of the Claude Code");
    app.unmount();
    expect(readSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("opens the account's menu on Enter, as the Accounts view does", async () => {
    const me = account(".claude-personal", "me@example.com");
    const work = account(".claude-work", "work@example.com");
    const state: AccountState = { accounts: [me, work], current: me, multiple: true, own: me.dir };
    const app = renderInk(
      <AccountContext.Provider value={state}>
        <SettingsView cwd={cwd} layout={layout} active select={{ key: `account:${work.dir}`, at: 1 }} noSession="no session here" />
      </AccountContext.Provider>,
      layout,
    );
    await expect.poll(app.frame, { timeout: 2000 }).toContain("↵ actions…");
    await app.press("\r");
    await expect.poll(app.frame).toContain("Continue it in work@example.com…");
    expect(app.frame()).toContain("What to do in work@example.com?");
    expect(app.frame()).toContain("no session here");
    expect(app.frame()).toContain("Open its config folder");
    app.unmount();
  });

  it("lists the avatars one per line, each followed by its meaning", () => {
    const row = SETTING_ROWS.find((r) => r.key === "accountAvatar")!;
    const lines = settingLines(row, "🦊", 80, { now: new Date(), cwd }).map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""));
    expect(lines).toContain('○ cco (default)  the "cco"');
    // The meanings in one column, after the widest value.
    const column = "○ cco (default)  ".length;
    const fox = lines.find((l) => l.includes("fox"))!;
    expect(fox).toMatch(/^● 🦊 +fox$/);
    expect(stringWidth(fox.slice(0, fox.indexOf("fox")))).toBe(column);
    expect(lines.some((l) => /^○ 👾👾👾 +space invaders$/.test(l))).toBe(true);
    const own = settingLines(row, "JH", 80, { now: new Date(), cwd }).map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""));
    expect(own.some((l) => /^● JH +your own$/.test(l))).toBe(true);
  });

  it("opens the avatar dialog on Enter and stores the avatar chosen", async () => {
    const me = account(".claude-personal", "me@example.com");
    const state: AccountState = { accounts: [me], current: me, multiple: false, own: me.dir };
    const app = renderInk(
      <AccountContext.Provider value={state}>
        <SettingsView cwd={cwd} layout={layout} active select={{ key: "accountAvatar", at: 1 }} />
      </AccountContext.Provider>,
      layout,
    );
    await expect.poll(app.frame, { timeout: 2000 }).toContain("↵ choose…");
    await app.press("\r");
    await expect.poll(app.frame).toContain("Avatar in the top bar");
    await app.press("🦊");
    await app.press("\r");
    await expect.poll(() => readSettings().accountAvatar).toBe("🦊");
    await expect.poll(app.frame).not.toContain("Avatar in the top bar");
    app.unmount();
  });
});
