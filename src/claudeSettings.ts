import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDir } from "./transcript/locate.js";

/** Claude Code's settings of this config folder (`env`, `statusLine`, …), which cco changes for Ctrl+G and the status line. */
export const claudeSettingsFile = () => join(claudeDir(), "settings.json");

/** Claude Code's settings.json: its object, undefined without the file, null if it is no JSON object (cco then leaves it alone). */
export function readClaudeSettings(): Record<string, unknown> | null | undefined {
  let text: string;
  try {
    text = readFileSync(claudeSettingsFile(), "utf8");
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Writes Claude Code's settings.json with `change` applied to a copy of it; a backup of the file before goes next to it
 * (`settings.json.cco-backup`). Throws, changing nothing, if the file is no JSON object.
 */
export function changeClaudeSettings(change: (settings: Record<string, unknown>) => void): void {
  const settings = readClaudeSettings();
  if (settings === null) throw new Error("settings.json is no valid JSON: cco leaves it alone");
  const next = { ...(settings ?? {}) };
  change(next);
  const file = claudeSettingsFile();
  if (existsSync(file)) writeFileSync(`${file}.cco-backup`, readFileSync(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
}
