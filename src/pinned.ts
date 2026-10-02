/**
 * The Pinned group (settings `pinnedFavorites`, `pinnedSessions`): a list's marked entries (and in Sessions the active and running ones) show
 * once more at the top of the screen, in the list's own display order, above
 * the whole list. Like `reversed` and the filter it only changes what is
 * shown: the views keep selection, positions and marks on the natural index;
 * which of an entry's two rows is selected is the list's own state.
 */

/**
 * The rows of a list with a Pinned group: natural indexes top to bottom, the
 * first `count` the pinned copies, then every entry shown in its place.
 */
export interface PinnedRows {
  order: number[];
  count: number;
  /** The selected row; -1 when the selected entry is not shown. */
  row: number;
}

/** The label of the separator above the Pinned group; the list below it starts with a plain line. */
export const PINNED_LABEL = "★ Pinned";

/** The entries of a list top to bottom (natural indexes): those shown, bottom-up when `reversed`. */
export function screenOrder(count: number, shown: number[] | undefined, reversed: boolean): number[] {
  const natural = shown ?? Array.from({ length: count }, (_, i) => i);
  return reversed ? [...natural].reverse() : natural;
}

/**
 * The marked entries of `screen` at the top, above all of `screen`;
 * undefined when none of them is marked. `inGroup`: the selection is the
 * pinned copy of `selected`, else its row in the list below.
 */
export function pinnedRows(screen: number[], marked: (index: number) => boolean, selected: number, inGroup: boolean): PinnedRows | undefined {
  const top = screen.filter(marked);
  if (top.length === 0) return undefined;
  const pinned = inGroup ? top.indexOf(selected) : -1;
  const below = screen.indexOf(selected);
  const row = pinned >= 0 ? pinned : below >= 0 ? top.length + below : -1;
  return { order: [...top, ...screen], count: top.length, row };
}

/** `delta` rows on from `row` among `length`, stopping at the ends; the first row when none is selected. */
export function stepRow(length: number, row: number, delta: number): number | undefined {
  if (length === 0) return undefined;
  if (row < 0) return 0;
  return Math.max(0, Math.min(length - 1, row + delta));
}

/** The next marked entry on screen after `selected`, downwards (`dir` 1) or upwards (-1). */
export function nextMarkedIn(order: number[], selected: number, dir: 1 | -1, marked: (index: number) => boolean): number | undefined {
  for (let at = order.indexOf(selected) + dir; at >= 0 && at < order.length; at += dir) if (marked(order[at])) return order[at];
  return undefined;
}

/**
 * Shift+↑/↓ with the group: the next pinned row down (`dir` 1) or up (-1).
 * Only the group's rows carry the ★, so from the list below it only goes up,
 * to the group's last row.
 */
export function nextPinnedRow({ count, row }: PinnedRows, dir: 1 | -1): number | undefined {
  if (row < 0) return undefined;
  if (row >= count) return dir < 0 ? count - 1 : undefined;
  const next = row + dir;
  return next >= 0 && next < count ? next : undefined;
}

/**
 * The row the selection goes to when the selected pinned copy is unmarked:
 * the pinned row below it, else the one above; undefined when it was the only
 * one, or the selection is not in the group (it then stays with the entry,
 * in its place in the list).
 */
export function afterUnpin(rows: PinnedRows | undefined): number | undefined {
  if (!rows) return undefined;
  const { count, row } = rows;
  if (row < 0 || row >= count) return undefined;
  if (row + 1 < count) return row + 1;
  return row > 0 ? row - 1 : undefined;
}
