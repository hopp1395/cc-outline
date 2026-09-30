import type { Key } from "ink";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { compileFilter, filterIndices, lineOf, nearestShown, stepShown, type FilterText, type LineState } from "../filter.js";
import type { FilterIn } from "../settings.js";
import { FilterDialog } from "./FilterDialog.js";
import { orderedNav, type FooterItem, type Layout } from "./layout.js";
import { afterUnpin, nextMarkedIn, pinnedRows, screenOrder, stepOrder, type PinnedRows } from "../pinned.js";
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
  /** The Pinned group (setting `pinnedGroup`), passed to `List`; undefined while off or nothing shown is marked. */
  pinned: PinnedRows | undefined;
  /** Shift+↑/↓: the next marked entry shown, down (1) or up (-1) the screen. */
  nextMark: (dir: 1 | -1) => number | undefined;
  /** Before `index` is unmarked: a pinned entry hands the selection to the next pinned one. */
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
}

/**
 * The filter of one list (Ctrl+F). Like `reversed`, it only changes what is
 * shown: the view keeps its data, selection, positions and marks on the
 * natural index, and gets the indexes to show. Kept while the viewer runs,
 * until the view is reloaded.
 */
export function useListFilter<T>({ items, text, deps = [], selected, select, reversed = false, layout, enabled = true, onTyping, keep, marked }: Options<T>): ListFilter {
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
  const [pinnedGroup] = useSetting("pinnedGroup");
  const isMarked = (i: number) => marked?.(items[i]) ?? false;
  // The entries top to bottom, and with the Pinned group the marked ones first.
  const screen = screenOrder(items.length, shown, reversed);
  const pinned = pinnedGroup && enabled && marked ? pinnedRows(screen, isMarked) : undefined;

  useEffect(() => {
    onTyping?.(open);
  }, [open]);

  // A reload of the view (F5) drops the filter.
  useOnReload(() => {
    setApplied("");
    setLine(undefined);
  });

  // A hidden entry is not left selected: the nearest shown one before it takes over.
  useEffect(() => {
    if (!shown || shown.length === 0 || shown.includes(selected)) return;
    const next = nearestShown(shown, selected);
    if (next !== undefined) select(next);
  }, [shown, selected]);

  const last = shown ? (shown.at(-1) ?? -1) : items.length - 1;
  // With the Pinned group, ↑↓ and first/last follow the rows on screen.
  const pinnedNav = pinned && {
    select: (delta: number) => {
      const next = stepOrder(pinned.order, selected, delta);
      if (next !== undefined) select(next);
    },
    first: () => select(pinned.order[0]),
    last: () => select(pinned.order.at(-1)!),
  };
  const nav = pinnedNav ?? orderedNav(reversed, {
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
    nextMark: (dir) => nextMarkedIn(pinned?.order ?? screen, selected, dir, isMarked),
    unmarking: (index) => {
      const next = afterUnpin(pinned, index);
      if (next !== undefined) select(next);
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

/** The part of an entry's texts the filter looks at. */
function pickText({ list, details }: FilterText, filterIn: FilterIn): string {
  if (filterIn === "list") return list;
  if (filterIn === "details") return details;
  return details ? `${list}
${details}` : list;
}
