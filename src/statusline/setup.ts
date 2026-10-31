import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changeClaudeSettings, readClaudeSettings } from "../claudeSettings.js";
import { cliFile } from "../cliPath.js";
import { readMainSettings, updateSettings } from "../settings.js";
import { claudeDir, readJson, writeJson } from "../transcript/locate.js";
import { isStatusLinePreset, type StatusLineSetting } from "./render.js";

/** What cco remembers of Claude Code's status line: the user's own (`statusLine` as it was before cco set its own). */
export const statusLineStateFile = () => join(claudeDir(), "cco", "statusline.json");
/** The input Claude Code handed the command last, for the Settings view's preview. */
export const statusLineInputFile = () => join(claudeDir(), "cco", "statusline-input.json");

/** The script `statusLine` runs: `statusline.js` next to the CLI npm's shim starts (as recorded), else next to this bundle. */
export function statusLineScript(): string {
  const cli = readJson<{ cli?: string }>(cliFile())?.cli;
  if (cli && /cli\.js$/.test(cli)) return join(dirname(cli), "statusline.js");
  return fileURLToPath(new URL("./statusline.js", import.meta.url));
}

/** The command `statusLine` is set to: node and the script, quoted, as for Ctrl+G. */
export const statusLineCommand = (script = statusLineScript()) => `"${process.execPath}" "${script}"`;

/** Whether a `statusLine` command runs cco's status line. */
export const isCcoStatusLine = (command: unknown): command is string => typeof command === "string" && /[\\/]dist[\\/]statusline\.js"?\s*$/.test(command);

const samePath = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

export interface StatusLineState {
  /** `statusLine` in Claude Code's settings.json, as it is. */
  current?: unknown;
  /** Its command, if it has one. */
  command?: string;
  /** It runs cco's status line. */
  cco: boolean;
  /** cco's, but its script is gone or another than the installed one's. */
  stale: boolean;
  /** settings.json is no JSON object: cco does not change it. */
  unreadable: boolean;
  /** The user's own status line, remembered before cco set its own. */
  own?: unknown;
}

const commandOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && typeof (value as { command?: unknown }).command === "string" ? (value as { command: string }).command : undefined;

/** The command of a status line as the Settings view names it; an entry without one as its JSON. */
export const describeStatusLine = (value: unknown): string => commandOf(value) ?? JSON.stringify(value);

export function readStatusLineState(expected = statusLineScript()): StatusLineState {
  const settings = readClaudeSettings();
  const current = settings?.statusLine;
  const command = commandOf(current);
  const cco = isCcoStatusLine(command);
  const script = cco ? /"([^"]*statusline\.js)"\s*$/.exec(command!)?.[1] : undefined;
  const own = readJson<{ own?: unknown }>(statusLineStateFile())?.own;
  return { current, command, cco, stale: cco && (!script || !existsSync(script) || !samePath(script, expected)), unreadable: settings === null, own };
}

/** Keeps a status line of the user's own, so `own` and `unchanged` can bring it back after cco set its own. */
function remember(state: StatusLineState): StatusLineState {
  if (state.current === undefined || state.cco || JSON.stringify(state.current) === JSON.stringify(state.own)) return state;
  writeJson(statusLineStateFile(), { own: state.current });
  return { ...state, own: state.current };
}

function writeStatusLine(value: unknown): void {
  changeClaudeSettings((settings) => {
    if (value === undefined) delete settings.statusLine;
    else settings.statusLine = value;
  });
}

/** Whether `own` can be chosen: a status line of the user's own is remembered, or set now. */
export function hasOwnStatusLine(state = readStatusLineState()): boolean {
  return state.own !== undefined || (state.current !== undefined && !state.cco);
}

/**
 * Sets Claude Code's `statusLine` for the setting's value. A status line of the user's own is remembered first; `own`
 * puts it back, `unchanged` too where cco's runs (else it leaves settings.json alone), `off` removes it, a preset sets
 * cco's command (which reads the preset from cco's settings each time, so a change of preset writes nothing).
 * Throws, changing nothing, if settings.json is no JSON object.
 */
export function applyStatusLine(target: StatusLineSetting, command = statusLineCommand()): void {
  let state = readStatusLineState();
  if (state.unreadable) throw new Error("Claude Code's settings.json is no valid JSON: cco leaves it alone");
  state = remember(state);
  if (target === "unchanged") {
    if (state.cco) writeStatusLine(state.own);
  } else if (target === "off") {
    if (state.current !== undefined) writeStatusLine(undefined);
  } else if (target === "own") {
    if (state.own === undefined) throw new Error("no status line of your own is remembered");
    if (JSON.stringify(state.current) !== JSON.stringify(state.own)) writeStatusLine(state.own);
  } else if (!state.cco || state.stale) writeStatusLine({ type: "command", command });
}

/**
 * The setting's value as Claude Code's settings.json has it now, which wins over what cco stored: cco's command keeps
 * the stored preset, another one is `own` (and is remembered), none is `off`. `unchanged` stays while cco runs none of its
 * own.
 */
export function syncedStatusLine(stored: StatusLineSetting): StatusLineSetting {
  let state = readStatusLineState();
  if (state.unreadable) return stored;
  if (state.cco) return isStatusLinePreset(stored) ? stored : "compact";
  state = remember(state);
  if (stored === "unchanged") return stored;
  return state.current === undefined ? "off" : "own";
}

/** Brings the stored setting in line with Claude Code's settings.json (the Settings view, the SessionStart hook). */
export function syncStatusLineSetting(): void {
  const stored = readMainSettings().statusLine;
  const synced = syncedStatusLine(stored);
  if (synced !== stored) updateSettings({ statusLine: synced });
}

/**
 * Points cco's status line at the installed script when it names another (moved, reinstalled, `npm link` and `-g`
 * swapped). Never touches a status line of the user's own. Returns whether it wrote.
 */
export function repairStatusLine(expected = statusLineScript()): boolean {
  const state = readStatusLineState(expected);
  if (!state.cco || !state.stale || state.unreadable || !existsSync(expected)) return false;
  writeStatusLine({ ...(typeof state.current === "object" && state.current !== null ? state.current : { type: "command" }), command: statusLineCommand(expected) });
  return true;
}
