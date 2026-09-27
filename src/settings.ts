import { join } from "node:path";
import { claudeDir, readJson, writeJson } from "./transcript/locate.js";
import { TOOL_LEVELS, type ToolLevel } from "./transcript/tools.js";
import type { Mode } from "./tui/layout.js";

/** When the hook opens the viewer as Claude Code starts. */
export const AUTO_OPEN_VALUES = ["remember", "always", "never"] as const;
export type AutoOpen = (typeof AUTO_OPEN_VALUES)[number];

/** Where the viewer opens: docked right or left of Claude Code, or in a window of its own. */
export const PLACEMENT_VALUES = ["right", "left", "window"] as const;
export type Placement = (typeof PLACEMENT_VALUES)[number];

/** Preferences kept across restarts, shared by all projects. */
export interface Settings {
  /**
   * Start: `remember` reopens the viewer if it was open when Claude Code last
   * exited in the project, `always` opens it on every start, `never` not at all.
   */
  autoOpen: AutoOpen;
  /** Where the viewer opens, unless the session has its own placement (chosen with p in the viewer). */
  placement: Placement;
  /** q and Esc ask before the viewer quits. */
  confirmQuit: boolean;
  /** The selected list entry scrolls when it is too long. */
  marquee: boolean;
  /** Selection and scroll positions are stored per project and restored after a restart. */
  rememberPositions: boolean;
  /** Each session reopens in the view it was shown in last. */
  rememberView: boolean;
  /** The viewer takes the mouse: click opens links and selects entries, the wheel scrolls. */
  mouse: boolean;
  /** Chat: how much of Claude's tool calls to show (t): off, a line each, or with command and output. Questions always show. */
  showTools: ToolLevel;
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
  /** Views in the tab bar; a hidden one has no tab and its number key does nothing. Settings is always shown. */
  viewChat: boolean;
  viewGit: boolean;
  viewPlan: boolean;
  viewSessions: boolean;
  viewMonitor: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoOpen: "remember",
  placement: "right",
  confirmQuit: true,
  marquee: true,
  rememberPositions: true,
  rememberView: true,
  mouse: true,
  showTools: "off",
  showThinking: false,
  showAgents: true,
  chatWrap: true,
  wrap: true,
  planWrap: true,
  allProjects: true,
  viewChat: true,
  viewGit: true,
  viewPlan: true,
  viewSessions: true,
  viewMonitor: true,
};

/** The setting that shows or hides each view; Settings has none, so the way back is always there. */
export const VIEW_SETTINGS: Record<Exclude<Mode, "settings">, keyof Settings> = {
  chat: "viewChat",
  git: "viewGit",
  plan: "viewPlan",
  sessions: "viewSessions",
  monitor: "viewMonitor",
};

/** Whether `mode` is shown in the tab bar and reachable by its key. */
export function isViewShown(settings: Settings, mode: Mode): boolean {
  return mode === "settings" || settings[VIEW_SETTINGS[mode]] === true;
}

/** The views in tab order. */
const TAB_ORDER: Mode[] = ["chat", "git", "plan", "sessions", "settings", "monitor"];

/** `mode` if it is shown, else the first shown view (Settings always is). */
export function shownView(settings: Settings, mode: Mode): Mode {
  return isViewShown(settings, mode) ? mode : (TAB_ORDER.find((m) => isViewShown(settings, m)) ?? "settings");
}

/** Allowed values of the settings that are not on/off. */
const CHOICES: Partial<Record<keyof Settings, readonly string[]>> = { autoOpen: AUTO_OPEN_VALUES, placement: PLACEMENT_VALUES, showTools: TOOL_LEVELS };

export function settingsFile(): string {
  return join(claudeDir(), "cco", "settings.json");
}

/** Stored settings over the defaults; unknown or mistyped values fall back to the default. */
export function readSettings(): Settings {
  const stored = readJson<Partial<Record<keyof Settings, unknown>>>(settingsFile()) ?? {};
  // showTools was on/off before it got levels.
  if (typeof stored.showTools === "boolean") stored.showTools = stored.showTools ? "compact" : "off";
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
