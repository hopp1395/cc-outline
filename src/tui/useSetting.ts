import { useSyncExternalStore } from "react";
import { readSettings, settingsFile, subscribeSettings, updateSettings, type Settings } from "../settings.js";

/**
 * Settings as last read, and from which file; re-read when this process changes one, so every view sees
 * the change, and when the file is another one (tests give each file its own CLAUDE_CONFIG_DIR).
 */
let cached: { file: string; settings: Settings } | undefined;
subscribeSettings(() => {
  cached = { file: settingsFile(), settings: readSettings() };
});
const current = () => {
  const file = settingsFile();
  if (cached?.file !== file) cached = { file, settings: readSettings() };
  return cached.settings;
};

/** A persisted preference as React state, shared by all views: written on every change. */
export function useSetting<K extends keyof Settings>(
  key: K,
): [Settings[K], (next: Settings[K] | ((prev: Settings[K]) => Settings[K])) => void] {
  const value = useSyncExternalStore(subscribeSettings, () => current()[key]);
  const set = (next: Settings[K] | ((prev: Settings[K]) => Settings[K])) => {
    const v = typeof next === "function" ? (next as (prev: Settings[K]) => Settings[K])(current()[key]) : next;
    if (v !== current()[key]) updateSettings({ [key]: v } as Partial<Settings>);
  };
  return [value, set];
}

/** All settings as React state, for the Settings view. */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, current);
}
