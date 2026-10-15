import { useEffect, useRef, useState, type SetStateAction } from "react";
import { readPositions, rememberScroll, rememberSelection, updatePositions, type ListPositions, type PositionList, type Selection } from "../positions.js";
import { makeScroll, type Scroll } from "./layout.js";
import { useSetting } from "./useSetting.js";

/** Delay before positions are written, so scrolling does not write on every line. */
const SAVE_DELAY_MS = 400;

/**
 * Where a list was left, kept across entry switches and viewer restarts:
 * the selected entry, whether it followed the newest, and a scroll position
 * per entry key. Stored per project in `<slug>.positions.json`. With `session` (the chat), the selection is kept
 * per session id: other viewers of the project may show other sessions. Only what this viewer changed is written,
 * into what is stored then, so theirs stay.
 */
export function usePositions(cwd: string, list: PositionList, session?: string) {
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
  // What this viewer changed since the last write: the scroll keys and the selections (per session, or the list's).
  const changed = useRef<{ scroll: Set<string>; selections: Map<string | undefined, Selection> }>({ scroll: new Set(), selections: new Map() });

  const write = () => {
    const { scroll, selections } = changed.current;
    if (scroll.size === 0 && selections.size === 0) return;
    changed.current = { scroll: new Set(), selections: new Map() };
    const mine = store.current!;
    updatePositions(cwd, list, (stored) => {
      for (const key of scroll) if (key in mine.scroll) rememberScroll(stored, key, mine.scroll[key]!);
      for (const [id, selection] of selections) {
        if (id === undefined) Object.assign(stored, selection);
        else rememberSelection(stored, id, selection);
      }
    });
  };
  const save = () => {
    clearTimeout(timer.current);
    if (!persist.current) return;
    timer.current = setTimeout(write, SAVE_DELAY_MS);
  };
  // Written right away when the view goes (the viewer quits).
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (persist.current) write();
    },
    [cwd, list],
  );

  const current = store.current;
  // The session's selection; one not stored yet falls back to the list's (files written before, a session just begun).
  const selection: Selection = (session !== undefined ? current.sessions?.[session] : undefined) ?? current;
  const scrolled = (key: string) => {
    changed.current.scroll.add(key);
    save();
  };
  return {
    /** The entry selected when the list was left, and whether it followed the newest entry. */
    selected: selection.selected,
    follow: selection.follow,
    /** Whether the selected entry's copy in the Pinned group was selected. */
    pinned: selection.pinned === true,
    /**
     * Stores the selection. `pinned` says whether its copy in the Pinned group is selected;
     * undefined keeps what is stored for the same entry (while the list restores it).
     */
    select(id: string | undefined, follow?: boolean, pinned?: boolean) {
      const copy = (pinned ?? (id === selection.selected && selection.pinned)) && follow !== true ? true : undefined;
      if (selection.selected === id && selection.follow === follow && selection.pinned === copy) return;
      const next: Selection = { selected: id, follow, pinned: copy };
      if (session !== undefined) rememberSelection(current, session, next);
      else Object.assign(current, next);
      changed.current.selections.set(session, next);
      save();
    },
    /** Stored scroll position of `key` (0 when unknown). */
    get: (key: string | undefined) => (key === undefined ? 0 : (current.scroll[key] ?? 0)),
    set(key: string | undefined, n: number) {
      if (key === undefined || current.scroll[key] === n) return;
      rememberScroll(current, key, Math.max(0, n));
      scrolled(key);
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
        scrolled(key);
      };
      return makeScroll(raw, setRaw, lineCount, height);
    },
  };
}
