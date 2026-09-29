import { Text } from "ink";
import { useContext, useState } from "react";
import { RANGE_NAMES, rangeStart } from "../settings.js";
import { dayKey } from "../monitor/responses.js";
import { dayLabel } from "./days.js";
import { AreaContext } from "./layout.js";
import { centredBadge } from "./Preview.js";
import { useSetting } from "./useSetting.js";

/** The last entry of the Sessions and Monitor lists while they show only their range. */
export const LOAD_MORE = { loadMore: true } as const;
export type LoadMore = typeof LOAD_MORE;
export const isLoadMore = (item: unknown): item is LoadMore => item === LOAD_MORE;

export interface RangeState {
  /** Local midnight of the range's first day; undefined once the whole history is read (or the range is unlimited). */
  since: number | undefined;
  /** Only the range is read: the list ends with load more. */
  more: boolean;
  /** Load more was asked for: the whole history is read, or being read. */
  requested: boolean;
  /** Load more: the whole history, until the viewer restarts; the setting stays. */
  loadAll: () => void;
  /** "the last 30 days", for the entry's preview. */
  name: string;
}

/**
 * How far back a list reaches: the range of its setting, until load more
 * reads the whole history. That stays while the viewer runs, also when the
 * setting changes; the views stay mounted, so their state is enough.
 */
export function useListRange(key: "sessionsRange" | "monitorRange"): RangeState {
  const [range] = useSetting(key);
  const [everything, setEverything] = useState(false);
  // Recomputed on each render, so the range moves on at midnight.
  const since = everything ? undefined : rangeStart(range);
  const name = range === "today" ? "today" : `the last ${RANGE_NAMES[range]}`;
  return { since, more: since !== undefined, requested: everything, loadAll: () => setEverything(true), name };
}

/**
 * Whether the list shows load more: while only the range is read, and after
 * the click until the whole history is (`complete`: the last finished scan
 * read it), so the entry shows the progress and keeps the selection meanwhile.
 */
export const showsLoadMore = (range: RangeState, complete: boolean) => range.more || (range.requested && !complete);

/** The row of the load more entry, a badge like the previews' "more lines": while the history is read, how far that got. */
export function LoadMoreRow({ progress }: { progress?: { done: number; total: number } }) {
  const area = useContext(AreaContext);
  const label = progress ? `↓ loading… ${progress.done}/${progress.total} ↓` : "↓ more ↓";
  return <Text>{centredBadge(label, area.width || 40)}</Text>;
}

/** The preview of the load more entry: what the list shows and what Enter does. */
export function loadMoreLines(range: RangeState, what: string, found: number, loading: boolean): string[] {
  const from = range.since !== undefined ? ` (since ${dayLabel(dayKey(range.since))})` : "";
  const shown = found > 0 ? `The list shows the ${what} of ${range.name}${from}.` : `No ${what} ${range.name === "today" ? "today" : `in ${range.name}`}${from}.`;
  return [shown, "", loading ? "Reading the whole history…" : "Enter or a click loads the whole history, until the viewer restarts."];
}
