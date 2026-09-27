import { join } from "node:path";
import { claudeDir, readJson, writeJson } from "./transcript/locate.js";

/** When the hook opens the viewer as Claude Code starts. */
export const AUTO_OPEN_VALUES = ["remember", "always", "never"] as const;
export type AutoOpen = (typeof AUTO_OPEN_VALUES)[number];

/** Preferences kept across restarts, shared by all projects. */
export interface Settings {
  /**
   * Start: `remember` reopens the viewer if it was open when Claude Code last
   * exited in the project, `always` opens it on every start, `never` not at all.
   */
  autoOpen: AutoOpen;
  /** q and Esc ask before the viewer quits. */
  confirmQuit: boolean;
  /** The selected list entry scrolls when it is too long. */
  marquee: boolean;
  /** Selection and scroll positions are stored per project and restored after a restart. */
  rememberPositions: boolean;
  /** Each session reopens in the view it was shown in last. */
  rememberView: boolean;
  /** Chat: show tool calls (t). */
  showTools: boolean;
  /** Chat: show thinking blocks (h). */
  showThinking: boolean;
  /** Chat: show the subagents Claude started, with their status. */
  showAgents: boolean;
  /** Chat: wrap long lines (w). */
  chatWrap: boolean;
  /** Changes: wrap long lines (w). */
  wrap: boolean;
  /** Plan: wrap long lines (w). */
  planWrap: boolean;
  /** Sessions: show the sessions of all projects, not only this one (a). */
  allProjects: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoOpen: "remember",
  confirmQuit: true,
  marquee: true,
  rememberPositions: true,
  rememberView: true,
  showTools: false,
  showThinking: false,
  showAgents: true,
  chatWrap: true,
  wrap: true,
  planWrap: true,
  allProjects: true,
};

/** Allowed values of the settings that are not on/off. */
const CHOICES: Partial<Record<keyof Settings, readonly string[]>> = { autoOpen: AUTO_OPEN_VALUES };

export function settingsFile(): string {
  return join(claudeDir(), "cco", "settings.json");
}

/** Stored settings over the defaults; unknown or mistyped values fall back to the default. */
export function readSettings(): Settings {
  const stored = readJson<Partial<Record<keyof Settings, unknown>>>(settingsFile()) ?? {};
  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = stored[key];
    if (typeof value !== typeof DEFAULT_SETTINGS[key]) continue;
    const choices = CHOICES[key];
    if (choices && !choices.includes(value as string)) continue;
    result[key] = value;
  }
  return result as unknown as Settings;
}

const listeners = new Set<() => void>();

/** Calls `listener` whenever this process changes a setting; returns the unsubscribe function. */
export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Merges `changes` into the stored settings, re-reading first so other viewers' changes survive. */
export function updateSettings(changes: Partial<Settings>): void {
  writeJson(settingsFile(), { ...readSettings(), ...changes });
  for (const listener of listeners) listener();
}
