import { join } from "node:path";
import { claudeDir, readJson, writeJson } from "./transcript/locate.js";

/** Display preferences kept across restarts, shared by all projects. */
export interface Settings {
  /** Chat: show tool calls (t). */
  showTools: boolean;
  /** Chat: show thinking blocks (h). */
  showThinking: boolean;
  /** Chat: wrap long lines (w). */
  chatWrap: boolean;
  /** Changes: wrap long lines (w). */
  wrap: boolean;
  /** Plan: wrap long lines (w). */
  planWrap: boolean;
}

export const DEFAULT_SETTINGS: Settings = { showTools: false, showThinking: false, chatWrap: true, wrap: true, planWrap: true };

export function settingsFile(): string {
  return join(claudeDir(), "cco", "settings.json");
}

/** Stored settings over the defaults; unknown or mistyped values fall back to the default. */
export function readSettings(): Settings {
  const stored = readJson<Partial<Record<keyof Settings, unknown>>>(settingsFile()) ?? {};
  const result = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof stored[key] === "boolean") result[key] = stored[key];
  }
  return result;
}

/** Merges `changes` into the stored settings, re-reading first so other viewers' changes survive. */
export function updateSettings(changes: Partial<Settings>): void {
  writeJson(settingsFile(), { ...readSettings(), ...changes });
}
