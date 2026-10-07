import type { Key } from "ink";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { compileFilter, filterIndices, lineOf, nearestShown, stepShown, type FilterText, type LineState } from "../filter.js";
import type { FilterIn } from "../settings.js";
import { FilterDialog } from "./FilterDialog.js";
import { orderedNav, type FooterItem, type Layout } from "./layout.js";
import { afterUnpin, nextMarkedIn, nextPinnedRow, pinnedRows, screenOrder, stepRow, type PinnedRows } from "../pinned.js";
import { useOnReload } from "./reload.js";
import { useSetting } from "./useSetting.js";

export interface ListFilter {
  /** The filter text in effect: the one typed while the dialog is open. */
  query: string;
  /** The natural indexes of the entries shown; undefined without a filter. */
  shown: number[] | undefined;
  /** The filter hides every entry: nothing is selected. */
  none: boolean;
  /** The dialog is open; the view takes no keys of its own. */
  open: boolean;
  /** ↑↓ and first/last through the shown entries, as handleNavigation takes them (already in screen order). */
  nav: { select: (delta: number) => void; first: () => void; last: () => void };
  /** The last shown entry, -1 when none is: what "the newest" means while a filter is on. */
  last: number;
  /** The Pinned group (settings `pinnedFavorites`, `pinnedSessions`), passed to `List`; undefined while off or nothing shown is pinned. */
  pinned: (PinnedRows & { choose: (row: number) => void }) | undefined;
  /** Shift+↑/↓: the next marked entry shown, down (1) or up (-1) the screen; with the Pinned group its rows. */
  nextMark: (dir: 1 | -1) => number | undefined;
  /**
   * The selected entry's copy in the Pinned group is selected, for `usePositions`' `select`;
   * undefined while the stored one is being restored and where the list has no group (the trash).
   */
  copySelected: boolean | undefined;
  /** Before `index` is unmarked: a selected pinned copy that leaves the group hands the selection to the next pinned one. */
  unmarking: (index: number) => void;
  /** Ctrl+F: opens the dialog, or drops the filter in effect. True when the key was taken. */
  handleKey: (input: string, key: Key) => boolean;
  /** "12/340" while filtered, else the total. */
  count: (total: number) => string;
  /** What the list shows when the filter leaves nothing, else undefined. */
  empty: string | undefined;
  /** For the list's top row while a filter is on (also while typing it). */
  banner: { query: string; count: string } | undefined;
  /** The help line's item: only while no filter is on, which the list's top row shows otherwise. */
  footer: FooterItem[];
  dialog: ReactNode;
}

interface Options<T> {
  items: T[];
  /** The texts an entry is found by: its row and its details (see `haystack`); the filterIn setting picks. */
  text: (item: T) => FilterText;
  /** Recompute the texts when these change (entries changed in place, shown values). */
  deps?: unknown[];
  /** The selected entry and how to select one, by natural index. */
  selected: number;
  select: (index: number) => void;
  /** The list is shown bottom-up. */
  reversed?: boolean;
  layout: Layout;
  /** False where the list has no filter (the trash): Ctrl+F does nothing. */
  enabled?: boolean;
  /** The dialog opened or closed: the app ignores its keys meanwhile. */
  onTyping?: (typing: boolean) => void;
  /** Entries a filter never hides and the counts leave out ("load more"). */
  keep?: (item: T) => boolean;
  /** Marked entries: Shift+↑/↓ jump to them, and the Pinned group shows them first. */
  marked?: (item: T) => boolean;
  /** Entries the Pinned group shows whatever the marks and `pinnedFavorites` say (Sessions: the active and running ones). */
  pin?: (item: T) => boolean;
  /**
   * The entry whose copy in the Pinned group was selected when the list was left (`usePositions`' `pinned`).
   * Once the view has selected it, its copy is selected if it is still pinned, else it stays in the list below.
   * Any choice of the user's before that ends the wait.
   */
  restoreCopy?: (item: T) => boolean;
}

/**
 * The filter of one list (Ctrl+F). Like `reversed`, it only changes what is
 * shown: the view keeps its data, selection, positions and marks on the
 * natural index, and gets the indexes to show. Kept while the viewer runs,
 * until the view is reloaded.
 */
export function useListFilter<T>({ items, text, deps = [], selected, select, reversed = false, layout, enabled = true, onTyping, keep, marked, pin, restoreCopy }: Options<T>): ListFilter {
  const [applied, setApplied] = useState("");
  // The text the dialog starts with: the filter used last.
  const [recent, setRecent] = useState("");
  const [line, setLine] = useState<LineState>();
  const open = line !== undefined;
  const query = enabled ? (line?.text ?? applied) : "";
  const match = useMemo(() => compileFilter(query), [query]);
  const [filterIn, setFilterIn] = useSetting("filterIn");
  // Built only while filtering; the texts of all sessions are not small.
  const texts = useMemo(
    () => (match ? items.map((item) => pickText(text(item), filterIn)) : undefined),
    [match !== undefined, items, filterIn, ...deps],
  );
  const shown = useMemo(() => {
    if (!match || !texts) return undefined;
    const found = new Set(filterIndices(texts, match));
    return items.flatMap((item, i) => (found.has(i) || keep?.(item) ? [i] : []));
  }, [match, texts]);
  // The entries that count: all but the kept ones.
  const matched = shown && (keep ? shown.filter((i) => !keep(items[i])).length : shown.length);
  const counted = keep ? items.filter((item) => !keep(item)).length : items.length;
  const [pinnedFavorites] = useSetting("pinnedFavorites");
  const isMarked = (i: number) => marked?.(items[i]) ?? false;
  const isPinned = (i: number) => (pinnedFavorites && isMarked(i)) || (pin?.(items[i]) ?? false);
  // The entries top to bottom, and with the Pinned group the pinned ones first.
  const screen = screenOrder(items.length, shown, reversed);
  // The entry whose pinned copy is selected, not its row in the list below; the views select by entry.
  const [groupCopy, setGroupCopy] = useState<number>();
  const rows = enabled ? pinnedRows(screen, isPinned, selected, groupCopy === selected) : undefined;
  const group = rows ? rows.order.slice(0, rows.count) : [];
  // The group as last rendered: where the selection goes when its copy leaves the group.
  const lastGroup = useRef<number[]>([]);
  // Waiting for the view to restore the entry whose pinned copy was selected last.
  const [restoring, setRestoring] = useState(() => restoreCopy !== undefined);
  const choose = (row: number) => {
    setRestoring(false);
    setGroupCopy(rows && row < rows.count ? rows.order[row] : undefined);
  };
  const pinned = rows && { ...rows, choose };
  /** Selects a row of the group's list: the entry, and which of its rows. */
  const selectRow = (row: number | undefined) => {
    if (!rows || row === undefined) return;
    choose(row);
    select(rows.order[row]);
  };

  useEffect(() => {
    onTyping?.(open);
  }, [open]);

  // The stored entry is selected again: its pinned copy, as when the list was left, or its row below when it is no longer pinned.
  useEffect(() => {
    if (!restoring || !enabled || !(selected in items) || !restoreCopy?.(items[selected])) return;
    setRestoring(false);
    if (isPinned(selected)) setGroupCopy(selected);
  });

  // A reload of the view (F5) drops the filter.
  useOnReload(() => {
    setApplied("");
    setLine(undefined);
  });

  // A selected pinned copy whose entry left the group without being unmarked (a session that
  // ended) hands the selection on like unmarking does; a hidden entry is left to the effect below.
  useEffect(() => {
    const before = lastGroup.current;
    lastGroup.current = group;
    if (groupCopy !== selected || group.includes(selected) || !screen.includes(selected)) return;
    const next = afterLeaving(before, group, selected);
    if (next === undefined) return setGroupCopy(undefined);
    setGroupCopy(next);
    select(next);
  });

  // A hidden entry is not left selected: the nearest shown one before it takes over.
  useEffect(() => {
    if (!shown || shown.length === 0 || shown.includes(selected)) return;
    const next = nearestShown(shown, selected);
    if (next !== undefined) select(next);
  }, [shown, selected]);

  const last = shown ? (shown.at(-1) ?? -1) : items.length - 1;
  // With the Pinned group, ↑↓ and first/last follow the rows on screen.
  const pinnedNav = rows && {
    select: (delta: number) => selectRow(stepRow(rows.order.length, rows.row, delta)),
    first: () => selectRow(0),
    last: () => selectRow(rows.order.length - 1),
  };
  const plainNav = orderedNav(reversed, {
    select: (delta: number) => {
      if (!shown) return select(selected + delta);
      const next = stepShown(shown, selected, delta);
      if (next !== undefined) select(next);
    },
    first: () => {
      if (!shown) return select(0);
      if (shown.length) select(shown[0]);
    },
    last: () => {
      if (last >= 0) select(last);
    },
  });
  const chosen = pinnedNav ?? plainNav;
  // A step of the user's ends the wait for the stored selection.
  const nav = {
    select: (delta: number) => {
      setRestoring(false);
      chosen.select(delta);
    },
    first: () => {
      setRestoring(false);
      chosen.first();
    },
    last: () => {
      setRestoring(false);
      chosen.last();
    },
  };

  const close = () => setLine(undefined);
  const handleKey = (input: string, key: Key) => {
    if (!enabled || !key.ctrl || input !== "f") return false;
    if (applied) setApplied("");
    else setLine(lineOf(recent));
    return true;
  };

  return {
    query,
    shown,
    none: shown?.length === 0,
    open,
    nav,
    last,
    pinned,
    copySelected: restoring || !enabled ? undefined : rows !== undefined && rows.row >= 0 && rows.row < rows.count,
    nextMark: (dir) => {
      setRestoring(false);
      if (!rows) return nextMarkedIn(screen, selected, dir, isMarked);
      const row = nextPinnedRow(rows, dir);
      if (row === undefined) return undefined;
      choose(row);
      return rows.order[row];
    },
    unmarking: (index) => {
      setRestoring(false);
      if (!rows || rows.order[rows.row] !== index || pin?.(items[index])) return;
      const next = afterUnpin(rows);
      // The only one: the selection stays with the entry, in its place below.
      if (next === undefined) return setGroupCopy(undefined);
      selectRow(next);
    },
    handleKey,
    count: (total) => (shown ? `${matched}/${total}` : String(total)),
    empty: shown?.length === 0 && items.length > 0 ? "No matches" : undefined,
    banner: shown ? { query: query.trim(), count: `${matched} of ${counted}` } : undefined,
    footer: shown || !enabled ? [] : [{ text: "^F filter", priority: 2 }],
    dialog:
      line && enabled ? (
        <FilterDialog
          layout={layout}
          line={line}
          shown={matched ?? counted}
          total={counted}
          onChange={setLine}
          onKeep={() => {
            const kept = line.text.trim();
            setApplied(kept);
            if (kept) setRecent(kept);
            close();
          }}
          onCancel={() => {
            setApplied("");
            close();
          }}
          onMove={nav.select}
          filterIn={filterIn}
          onFilterIn={setFilterIn}
        />
      ) : null,
  };
}

/**
 * The entry the selection goes to when `entry` left the group: the next one of
 * the group before that is still in it, else the one above; undefined when none is.
 */
export function afterLeaving(before: number[], after: number[], entry: number): number | undefined {
  const at = before.indexOf(entry);
  if (at < 0) return undefined;
  const stays = (i: number) => after.includes(i);
  return before.slice(at + 1).find(stays) ?? before.slice(0, at).reverse().find(stays);
}

/** The part of an entry's texts the filter looks at. */
function pickText({ list, details }: FilterText, filterIn: FilterIn): string {
  if (filterIn === "list") return list;
  if (filterIn === "details") return details;
  return details ? `${list}
${details}` : list;
}
