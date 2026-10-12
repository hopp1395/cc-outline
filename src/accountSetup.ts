import { existsSync } from "node:fs";
import { join } from "node:path";
import { cliFile } from "./cliPath.js";
import { independentEnv } from "./open.js";
import { settingsFile } from "./settings.js";
import { claudeDir, inClaudeDir, readJson, withClaudeDir, writeJson } from "./transcript/locate.js";
import { runCommandWith, type RunCommand, type UpdateStep } from "./update.js";

const PLUGIN = "cco@cc-outline";
const MARKETPLACE = "cc-outline";
/** Where the marketplace comes from when this account does not know it either: the repository on GitHub. */
const DEFAULT_SOURCE = "hopp1395/cc-outline";

/** Whether the cco plugin runs in the account of config folder `dir`: its marketplace known, the plugin installed and not disabled. */
export interface PluginState {
  marketplace: boolean;
  installed: boolean;
  enabled: boolean;
}

export function pluginState(dir: string): PluginState {
  const known = readJson<Record<string, unknown>>(join(dir, "plugins", "known_marketplaces.json"));
  const plugins = readJson<{ plugins?: Record<string, unknown> }>(join(dir, "plugins", "installed_plugins.json"))?.plugins?.[PLUGIN];
  const enabled = readJson<{ enabledPlugins?: Record<string, unknown> }>(join(dir, "settings.json"))?.enabledPlugins?.[PLUGIN];
  return {
    marketplace: !!known && typeof known === "object" && MARKETPLACE in known,
    installed: Array.isArray(plugins) && plugins.length > 0,
    enabled: enabled !== false,
  };
}

/**
 * The marketplace source `claude plugin marketplace add` takes for cc-outline: the one this account added it
 * from (a folder, e.g. the npm package, or a GitHub repository), else the repository.
 */
export function marketplaceSource(own = claudeDir()): string {
  const entry = readJson<Record<string, { source?: Record<string, unknown> }>>(join(own, "plugins", "known_marketplaces.json"))?.[MARKETPLACE]?.source;
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const source = text(entry?.path) ?? text(entry?.repo) ?? text(entry?.url);
  return source ?? DEFAULT_SOURCE;
}

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** The commands that make the cco plugin run in the account of `dir`; none when it does already. */
export function pluginSteps(dir: string, own = claudeDir()): UpdateStep[] {
  const state = pluginState(dir);
  const steps: UpdateStep[] = [];
  if (!state.marketplace && !state.installed) steps.push({ label: "marketplace", command: `claude plugin marketplace add ${quote(marketplaceSource(own))}` });
  if (!state.installed) steps.push({ label: "plugin", command: `claude plugin install ${PLUGIN}` });
  else if (!state.enabled) steps.push({ label: "enable", command: `claude plugin enable ${PLUGIN}` });
  return steps;
}

/** Runs a command as Claude Code of the account in `dir` would: its config folder, without this session's variables. */
export const runInAccount = (dir: string): RunCommand => runCommandWith(withClaudeDir(independentEnv(), dir));

/**
 * Gives the account of `dir` what cco needs besides the plugin: the CLI's path for the plugin's launcher (else it
 * starts cco through the slow shell) and, if it has none yet, this account's settings, so the viewer looks the
 * same there. The account colour is chosen per folder and stays out.
 */
export function prepareAccount(dir: string): void {
  const cli = readJson<{ cli?: unknown }>(cliFile());
  const settings = readJson<Record<string, unknown>>(settingsFile());
  inClaudeDir(dir, () => {
    if (cli && typeof cli.cli === "string" && !readJson(cliFile())) writeJson(cliFile(), { cli: cli.cli });
    if (settings && !existsSync(settingsFile())) {
      const { accountColor: _colour, ...rest } = settings;
      writeJson(settingsFile(), rest);
    }
  });
}
