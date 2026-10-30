import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupSteps } from "../src/accountSetup.js";
import { runSetup } from "../src/setup.js";
import { claudeDir } from "../src/transcript/locate.js";
import type { RunCommand } from "../src/update.js";

const NPM_ROOT = join(tmpdir(), "cco-setup-npm", "node_modules", "cc-outline");
/** How the commands name it: quoted if the temp folder has a space. */
const SOURCE = NPM_ROOT.includes(" ") ? `"${NPM_ROOT}"` : NPM_ROOT;
const put = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-setup-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

/** Runs cco setup with commands that exit with `code` (by command), returning the commands run and the lines printed. */
async function setup(root = NPM_ROOT, code: (command: string) => number = () => 0) {
  const ran: string[] = [];
  const lines: string[] = [];
  const run: RunCommand = async (command, onOutput) => {
    ran.push(command);
    if (code(command) !== 0) onOutput("claude: not found\n");
    return code(command);
  };
  const exit = await runSetup({ root, run, out: (l) => lines.push(l) });
  return { exit, ran, lines };
}

describe("cco setup", () => {
  it("adds the running package as the marketplace and installs the plugin", async () => {
    const { exit, ran, lines } = await setup();
    expect(exit).toBe(0);
    expect(ran).toEqual([`claude plugin marketplace add ${SOURCE}`, "claude plugin install cco@cc-outline"]);
    expect(lines.at(-1)).toBe("Done. Restart Claude Code, then type /cco:chat.");
  });

  it("keeps the marketplace the account added before, and only enables a disabled plugin", () => {
    put(join(claudeDir(), "plugins", "known_marketplaces.json"), { "cc-outline": { source: { source: "github", repo: "hopp1395/cc-outline" } } });
    expect(setupSteps(NPM_ROOT).map((s) => s.command)).toEqual(["claude plugin install cco@cc-outline"]);
    put(join(claudeDir(), "plugins", "installed_plugins.json"), { plugins: { "cco@cc-outline": [{ scope: "user" }] } });
    put(join(claudeDir(), "settings.json"), { enabledPlugins: { "cco@cc-outline": false } });
    expect(setupSteps(NPM_ROOT).map((s) => s.command)).toEqual(["claude plugin enable cco@cc-outline"]);
  });

  it("runs nothing when the plugin is installed and enabled", async () => {
    put(join(claudeDir(), "plugins", "installed_plugins.json"), { plugins: { "cco@cc-outline": [{ scope: "user" }] } });
    const { exit, ran, lines } = await setup();
    expect(exit).toBe(0);
    expect(ran).toEqual([]);
    expect(lines.join("\n")).toContain("is installed and enabled");
  });

  it("stops at the first failed command and names what is left to run by hand", async () => {
    const { exit, ran, lines } = await setup(NPM_ROOT, (c) => (c.includes("marketplace") ? 1 : 0));
    expect(exit).toBe(1);
    expect(ran).toHaveLength(1);
    expect(lines).toContain("      claude: not found");
    expect(lines.at(-1)).toBe(`Run by hand: claude plugin marketplace add ${SOURCE} && claude plugin install cco@cc-outline`);
  });

  it("refuses to run from the npx cache, which goes away", async () => {
    const { exit, ran } = await setup(join(tmpdir(), "_npx", "abc", "node_modules", "cc-outline"));
    expect(exit).toBe(1);
    expect(ran).toEqual([]);
  });
});
