import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk, until } from "./helpers/ink.js";
import type { Account } from "../src/account.js";
import { accountSessions, transcriptTitle } from "../src/accountsInfo.js";
import { readSettings } from "../src/settings.js";
import { projectSlug } from "../src/transcript/locate.js";
import { accountEntries, AccountsView } from "../src/tui/AccountsView.js";
import { tabAt, type Layout } from "../src/tui/layout.js";
import { AccountContext, type AccountState } from "../src/tui/useAccount.js";

const layout: Layout = { columns: 120, rows: 30, listWidth: 40, previewWidth: 77, bodyHeight: 26 };
const cwd = join(tmpdir(), "cco-accounts-project");
let saved: string | undefined;
let own: string;
let other: string;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  own = mkdtempSync(join(tmpdir(), "cco-accounts-own-"));
  other = mkdtempSync(join(tmpdir(), "cco-accounts-other-"));
  process.env.CLAUDE_CONFIG_DIR = own;
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const account = (dir: string, email: string): Account => ({ dir, file: join(dir, ".claude.json"), email, organization: "Org" });
const stateOf = (): AccountState => {
  const accounts = [account(own, "me@home.de"), account(other, "jan@work.com")];
  return { accounts, current: accounts[0], multiple: true, own };
};
const line = (entry: object) => JSON.stringify(entry) + "\n";

/** A transcript of the project in the other account, with a title at its end. */
function otherSession(id: string, title: string) {
  const dir = join(other, "projects", projectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    line({ type: "user", uuid: "u", message: { role: "user", content: "hi" } }) + line({ type: "custom-title", customTitle: title, sessionId: id }),
  );
}

const render = (props: Partial<Parameters<typeof AccountsView>[0]> = {}) =>
  renderInk(
    <AccountContext.Provider value={stateOf()}>
      <AccountsView cwd={cwd} layout={layout} visible active {...props} />
    </AccountContext.Provider>,
    layout,
  );

describe("the Accounts view", () => {
  it("is the cco at the start of the top bar", () => {
    expect(tabAt(0, readSettings(), "chat")).toBe("accounts");
    expect(tabAt(2, readSettings(), "chat")).toBe("accounts");
    expect(tabAt(5, readSettings(), "chat")).toBe("chat");
  });

  it("lists the active account first, the others by email, then how they are found; a note without any", () => {
    const a = account("/a", "zed@x");
    const b = account("/b", "amy@x");
    const c = account("/c", "bob@x");
    expect(accountEntries({ accounts: [b, a, c], current: a }).map((e) => (e.kind === "account" ? e.account.email : e.kind))).toEqual(["zed@x", "amy@x", "bob@x", "details"]);
    expect(accountEntries({ accounts: [] }).map((e) => e.kind)).toEqual(["none", "details"]);
  });

  it("reads the sessions of the project in another account without reading them in full", () => {
    otherSession("s1", "Orders work");
    writeFileSync(join(other, "projects", projectSlug(cwd), "tiny.jsonl"), line({ type: "bridge-session" }));
    const s = accountSessions(other, cwd);
    expect(s.count).toBe(1);
    expect(s.newest?.title).toBe("Orders work");
    expect(transcriptTitle(join(other, "nothing.jsonl"), 0)).toBeUndefined();
  });

  it("shows an account's details: the plugin, what runs and the project's sessions there", async () => {
    otherSession("s1", "Orders work");
    mkdirSync(join(other, "sessions"), { recursive: true });
    writeFileSync(join(other, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s1", cwd: join(tmpdir(), "orders"), status: "busy" }));
    const view = render();
    await until(() => view.frame().includes("jan@work.com"));
    await view.press("\u001b[B");
    await until(() => view.frame().includes("Running now (1)"));
    const frame = view.frame();
    expect(frame).toContain("not installed");
    expect(frame).toContain("orders · working");
    expect(frame).toContain("Sessions of cco-accounts-project (1)");
    expect(frame).toContain("Orders work");
    view.unmount();
  });

  it("continues the session in another account on Enter, and says why not without one", async () => {
    const continued: string[] = [];
    const view = render({ onContinue: (a) => void continued.push(a.email) });
    await until(() => view.frame().includes("jan@work.com"));
    // The active account continues nothing.
    await view.press("\r");
    await until(() => view.frame().includes("this is the active account"));
    await view.press("\u001b[B");
    await until(() => view.frame().includes("Enter continues this viewer's session"));
    await view.press("\r");
    await until(() => continued.length > 0);
    expect(continued).toEqual(["jan@work.com"]);
    view.unmount();

    const none = render({ noSession: "this viewer follows no Claude Code" });
    await until(() => none.frame().includes("jan@work.com"));
    // The selection is kept (jan@work.com): from the first entry, one down.
    await none.press("g");
    await none.press("\u001b[B");
    await none.press("\r");
    await until(() => none.frame().includes("this viewer follows no Claude Code"));
    none.unmount();
  });
});
