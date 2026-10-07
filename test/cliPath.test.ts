import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliFile, recordCli } from "../src/cliPath.js";
import { readJson } from "../src/transcript/locate.js";

const saved = process.env.CLAUDE_CONFIG_DIR;
beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-cli-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("recordCli", () => {
  it("records the path npm's shim started the CLI by", () => {
    const shim = "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\cc-outline\\dist\\cli.js";
    recordCli(shim);
    expect(readJson(cliFile())).toEqual({ cli: shim });
    recordCli("/usr/lib/node_modules/cc-outline/dist/cli.js");
    expect(readJson(cliFile())).toEqual({ cli: "/usr/lib/node_modules/cc-outline/dist/cli.js" });
  });

  it("leaves it alone when started otherwise (a checkout, the plugin's launcher)", () => {
    recordCli("C:\\Workspace\\cc-outline\\dist\\cli.js");
    recordCli("C:/Users/u/.claude/plugins/cache/cc-outline/cco/0.8.2/scripts/cco.mjs");
    recordCli(undefined);
    expect(readJson(cliFile())).toBeUndefined();
  });
});

describe("plugin", () => {
  const plugin = join(import.meta.dirname, "..", "plugin");

  it("runs the CLI through its launcher, not npm's shim", () => {
    const hooks = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, { hooks: { command: string; args?: string[] }[] }[]>;
    };
    for (const [event, groups] of Object.entries(hooks.hooks))
      for (const { command, args } of groups.flatMap((g) => g.hooks)) expect({ event, command, args }).toEqual({ event, command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/cco.mjs", "hook"] });
    for (const name of readdirSync(join(plugin, "commands"))) {
      const text = readFileSync(join(plugin, "commands", name), "utf8");
      expect(text, name).toMatch(/^allowed-tools: Bash\(node:\*\)$/m);
      expect(text, name).toMatch(/^!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cco\.mjs" (open --(view|action) |open --last-view`|doctor`)/m);
    }
  });
});
