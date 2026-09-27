import { useSyncExternalStore } from "react";
import { readSettings, subscribeSettings, updateSettings, type Settings } from "../settings.js";

/** Settings as last read; re-read when this process changes one, so every view sees the change. */
let cached: Settings | undefined;
subscribeSettings(() => {
  cached = readSettings();
});
const current = () => (cached ??= readSettings());

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
