import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_COLOR_NAMES, accountColorName, accountDirs, accountInfo, accountOfProcess, colorOfAccount, findAccounts, readAccount } from "../src/account.js";

/** A home folder with the given config folders; a value is the email its `.claude.json` names, undefined: no such file. */
function homeWith(folders: Record<string, string | undefined>, homeFile?: string): string {
  const home = mkdtempSync(join(tmpdir(), "cco-account-"));
  for (const [name, email] of Object.entries(folders)) {
    mkdirSync(join(home, name), { recursive: true });
    if (email) writeFileSync(join(home, name, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: "Org" } }));
  }
  if (homeFile) writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: homeFile, displayName: "Home" } }));
  return home;
}

describe("accounts", () => {
  it("reads the account from the config folder's .claude.json", () => {
    const home = homeWith({ ".claude-work": "work@example.com" });
    const account = readAccount(join(home, ".claude-work"), home);
    expect(account).toMatchObject({ email: "work@example.com", organization: "Org", dir: join(home, ".claude-work") });
  });

  it("reads the default folder's account from ~/.claude.json, but no other folder's", () => {
    const home = homeWith({ ".claude": undefined, ".claude-work": undefined }, "me@example.com");
    expect(readAccount(join(home, ".claude"), home)?.email).toBe("me@example.com");
    // A folder not signed in yet must not show the default account.
    expect(readAccount(join(home, ".claude-work"), home)).toBeUndefined();
  });

  it("finds the folders ~/.claude* with an account, the viewer's own first, and ignores the rest", () => {
    const home = homeWith({ ".claude-work": "work@example.com", ".claude-personal": "me@example.com", ".claude-code-router": undefined, ".config": "other@example.com" });
    writeFileSync(join(home, ".claude-notes"), "a file");
    const own = join(home, ".claude-personal");
    const dirs = accountDirs(home, own).map((d) => d.slice(home.length + 1));
    expect(dirs[0]).toBe(".claude-personal");
    expect(dirs.sort()).toEqual([".claude", ".claude-code-router", ".claude-personal", ".claude-work"]);
    const found = findAccounts(home, own);
    expect(found.map((a) => a.email)).toEqual(["me@example.com", "work@example.com"]);
    expect(accountInfo(undefined, home, own)).toMatchObject({ multiple: true, current: { email: "me@example.com" } });
  });

  it("counts one account as not worth showing", () => {
    const home = homeWith({ ".claude": undefined }, "me@example.com");
    const info = accountInfo(undefined, home, join(home, ".claude"));
    expect(info.multiple).toBe(false);
    expect(info.current?.email).toBe("me@example.com");
  });

  it("takes the account of the folder whose sessions hold the process", () => {
    const home = homeWith({ ".claude-work": "work@example.com", ".claude-personal": "me@example.com" });
    mkdirSync(join(home, ".claude-work", "sessions"));
    writeFileSync(join(home, ".claude-work", "sessions", "4242.json"), "{}");
    const own = join(home, ".claude-personal");
    const accounts = findAccounts(home, own);
    expect(accountOfProcess(4242, accounts, accounts[0])?.email).toBe("work@example.com");
    // Unknown process, or none: the viewer's own.
    expect(accountOfProcess(1, accounts, accounts[0])?.email).toBe("me@example.com");
    expect(accountOfProcess(undefined, accounts, accounts[0])?.email).toBe("me@example.com");
  });

  it("gives an email the same colour every time, whatever its case, and a chosen one wins", () => {
    const color = accountColorName("work@example.com");
    expect(ACCOUNT_COLOR_NAMES).toContain(color);
    expect(accountColorName(" Work@Example.com ")).toBe(color);
    expect(accountColorName("work@example.com", "pink")).toBe("pink");
    // Different emails spread over the palette.
    const used = new Set(Array.from({ length: 40 }, (_, i) => accountColorName(`user${i}@example.com`)));
    expect(used.size).toBeGreaterThan(3);
  });

  it("applies the colour chosen in this viewer's settings only to its own folder", () => {
    const home = homeWith({ ".claude-work": "work@example.com", ".claude-personal": "me@example.com" });
    const own = join(home, ".claude-personal");
    const info = accountInfo(undefined, home, own);
    const [mine, other] = info.accounts;
    expect(colorOfAccount(mine, info, "pink")).toBe("pink");
    expect(colorOfAccount(other, info, "pink")).toBe(accountColorName("work@example.com"));
  });
});
