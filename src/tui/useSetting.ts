import { useState } from "react";
import { readSettings, updateSettings, type Settings } from "../settings.js";

/** A persisted preference as React state: read once at start, written on every change. */
export function useSetting<K extends keyof Settings>(
  key: K,
): [Settings[K], (next: Settings[K] | ((prev: Settings[K]) => Settings[K])) => void] {
  const [value, setValue] = useState<Settings[K]>(() => readSettings()[key]);
  const set = (next: Settings[K] | ((prev: Settings[K]) => Settings[K])) => {
    const v = typeof next === "function" ? (next as (prev: Settings[K]) => Settings[K])(value) : next;
    setValue(v);
    updateSettings({ [key]: v } as Partial<Settings>);
  };
  return [value, set];
}
