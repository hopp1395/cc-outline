import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_COLOR_NAMES, AUTO_COLORS, accountColorName, accountDirs, accountInfo, accountOfProcess, avatarOfAccount, chosenAvatarOf, chosenColorOf, colorOfAccount, findAccounts, hasChosenColor, readAccount } from "../src/account.js";

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

  it("reads a folder whose settings name another server as an API profile, whatever login it holds", () => {
    const home = homeWith({ ".claude-qwen": undefined, ".claude-gw": "old@example.com", ".claude-raw": undefined });
    const env = (name: string, values: Record<string, string>) => writeFileSync(join(home, name, "settings.json"), JSON.stringify({ env: values }));
    env(".claude-qwen", { ANTHROPIC_BASE_URL: "http://rzisrv051.rz.example.com:8000", ANTHROPIC_MODEL: "qwen3.8-27b" });
    env(".claude-gw", { ANTHROPIC_BASE_URL: "https://gateway.example.com" });
    env(".claude-raw", { ANTHROPIC_BASE_URL: "not a url" });
    expect(readAccount(join(home, ".claude-qwen"), home)).toMatchObject({
      email: "qwen3.8-27b @ rzisrv051",
      api: { baseUrl: "http://rzisrv051.rz.example.com:8000", model: "qwen3.8-27b" },
      file: join(home, ".claude-qwen", "settings.json"),
    });
    expect(readAccount(join(home, ".claude-gw"), home)?.email).toBe("API @ gateway");
    expect(readAccount(join(home, ".claude-raw"), home)?.email).toBe("API @ not a url");
    // Settings without the server's address leave a folder as it was.
    writeFileSync(join(home, ".claude-raw", "settings.json"), JSON.stringify({ env: { DISABLE_TELEMETRY: "1" } }));
    expect(readAccount(join(home, ".claude-raw"), home)).toBeUndefined();
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
    expect(AUTO_COLORS).toContain(color);
    expect(accountColorName(" Work@Example.com ")).toBe(color);
    expect(accountColorName("work@example.com", "magentaBright")).toBe("magentaBright");
    // Different emails spread over the palette.
    const used = new Set(Array.from({ length: 40 }, (_, i) => accountColorName(`user${i}@example.com`)));
    expect(used.size).toBeGreaterThan(3);
  });

  it("offers the console's 16 colours in ANSI order, auto only the coloured ones apart from blue", () => {
    expect(ACCOUNT_COLOR_NAMES).toEqual(["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "blackBright", "redBright", "greenBright", "yellowBright", "blueBright", "magentaBright", "cyanBright", "whiteBright"]);
    const used = new Set(Array.from({ length: 200 }, (_, i) => accountColorName(`user${i}@example.com`)));
    for (const name of ["black", "white", "blackBright", "whiteBright", "blue", "blueBright"]) expect(used).not.toContain(name);
    expect(used.size).toBe(AUTO_COLORS.length);
  });

  it("applies the colour chosen in this viewer's settings only to its own folder, and reads the others' from theirs", () => {
    const home = homeWith({ ".claude-work": "work@example.com", ".claude-personal": "me@example.com" });
    const own = join(home, ".claude-personal");
    const info = accountInfo(undefined, home, own);
    const [mine, other] = info.accounts;
    expect(colorOfAccount(mine, info, "magentaBright")).toBe("magentaBright");
    expect(colorOfAccount(other, info, "magentaBright")).toBe(accountColorName("work@example.com"));
    expect(hasChosenColor(other, info, "magentaBright")).toBe(false);
    // The other account chose a colour in its own folder's settings: every viewer shows it so.
    mkdirSync(join(home, ".claude-work", "cco"), { recursive: true });
    writeFileSync(join(home, ".claude-work", "cco", "settings.json"), JSON.stringify({ accountColor: "yellowBright" }));
    const again = accountInfo(undefined, home, own);
    const work = again.accounts.find((a) => a.email === "work@example.com")!;
    expect(colorOfAccount(work, again, "magentaBright")).toBe("yellowBright");
    expect(hasChosenColor(work, again, "magentaBright")).toBe(true);
    // An unknown value counts as auto.
    writeFileSync(join(home, ".claude-work", "cco", "settings.json"), JSON.stringify({ accountColor: "teal" }));
    expect(chosenColorOf(join(home, ".claude-work"))).toBe("auto");
  });

  it("takes this viewer's avatar from its live setting and the others' from their folders", () => {
    const home = homeWith({ ".claude-work": "work@example.com", ".claude-personal": "me@example.com" });
    const own = join(home, ".claude-personal");
    mkdirSync(join(home, ".claude-work", "cco"), { recursive: true });
    writeFileSync(join(home, ".claude-work", "cco", "settings.json"), JSON.stringify({ accountAvatar: "🐙" }));
    const info = accountInfo(undefined, home, own);
    const mine = info.accounts.find((a) => a.dir === own)!;
    const work = info.accounts.find((a) => a.email === "work@example.com")!;
    expect(avatarOfAccount(mine, info, "🦊")).toBe("🦊");
    expect(avatarOfAccount(mine, info, "")).toBeUndefined();
    expect(avatarOfAccount(work, info, "🦊")).toBe("🐙");
    // Not one: too wide.
    writeFileSync(join(home, ".claude-work", "cco", "settings.json"), JSON.stringify({ accountAvatar: "toolong" }));
    expect(chosenAvatarOf(join(home, ".claude-work"))).toBeUndefined();
  });
});
