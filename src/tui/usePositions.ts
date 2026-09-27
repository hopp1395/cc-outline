import { useEffect, useRef, useState, type SetStateAction } from "react";
import { readPositions, rememberScroll, savePositions, type ListPositions, type PositionList } from "../positions.js";
import { makeScroll, type Scroll } from "./layout.js";
import { useSetting } from "./useSetting.js";

/** Delay before positions are written, so scrolling does not write on every line. */
const SAVE_DELAY_MS = 400;

/**
 * Where a list was left, kept across entry switches and viewer restarts:
 * the selected entry, whether it followed the newest, and a scroll position
 * per entry key. Stored per project in `<slug>.positions.json`.
 */
export function usePositions(cwd: string, list: PositionList) {
  // Off: positions are kept only while the viewer runs; the file is neither read nor written.
  const [remember] = useSetting("rememberPositions");
  const persist = useRef(remember);
  persist.current = remember;
  const store = useRef<ListPositions>(undefined);
  const storeCwd = useRef<string>(undefined);
  if (!store.current || storeCwd.current !== cwd) {
    store.current = remember ? readPositions(cwd, list) : { scroll: {} };
    storeCwd.current = cwd;
  }
  const [, rerender] = useState(0);
  const timer = useRef<NodeJS.Timeout>(undefined);

  const save = () => {
    clearTimeout(timer.current);
    if (!persist.current) return;
    timer.current = setTimeout(() => savePositions(cwd, list, store.current!), SAVE_DELAY_MS);
  };
  // Written right away when the view goes (the viewer quits).
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (persist.current) savePositions(cwd, list, store.current!);
    },
    [cwd, list],
  );

  const current = store.current;
  return {
    /** The entry selected when the list was left, and whether it followed the newest entry. */
    selected: current.selected,
    follow: current.follow,
    select(id: string | undefined, follow?: boolean) {
      if (current.selected === id && current.follow === follow) return;
      current.selected = id;
      current.follow = follow;
      save();
    },
    /** Stored scroll position of `key` (0 when unknown). */
    get: (key: string | undefined) => (key === undefined ? 0 : (current.scroll[key] ?? 0)),
    set(key: string | undefined, n: number) {
      if (key === undefined || current.scroll[key] === n) return;
      rememberScroll(current, key, Math.max(0, n));
      save();
    },
    /**
     * A scroll over `lineCount` lines whose position belongs to `key`: each
     * entry (and each detail of it) keeps its own. The stored value may exceed
     * the content; it is clamped when read, like `makeScroll`.
     */
    scroll(key: string | undefined, lineCount: number, height: number): Scroll {
      const raw = key === undefined ? 0 : (current.scroll[key] ?? 0);
      const setRaw = (update: SetStateAction<number>) => {
        if (key === undefined) return;
        const prev = current.scroll[key] ?? 0;
        const next = typeof update === "function" ? update(prev) : update;
        if (next === prev) return;
        rememberScroll(current, key, next);
        rerender((n) => n + 1);
        save();
      };
      return makeScroll(raw, setRaw, lineCount, height);
    },
  };
}
