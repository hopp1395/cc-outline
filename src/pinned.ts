/**
 * The Pinned group (setting `pinnedGroup`): a list's marked entries move to
 * the top of the screen, in the list's own display order, above the rest.
 * Like `reversed` and the filter it only changes what is shown: the views
 * keep selection, positions and marks on the natural index.
 */

/** The rows of a list with a Pinned group: natural indexes top to bottom, the first `count` pinned. */
export interface PinnedRows {
  order: number[];
  count: number;
}

/** The label of the separator above the Pinned group, and of the one below it. */
export const PINNED_LABEL = "★ Pinned";
export const PINNED_END_LABEL = "Pinned end";

/** The entries of a list top to bottom (natural indexes): those shown, bottom-up when `reversed`. */
export function screenOrder(count: number, shown: number[] | undefined, reversed: boolean): number[] {
  const natural = shown ?? Array.from({ length: count }, (_, i) => i);
  return reversed ? [...natural].reverse() : natural;
}

/** The marked entries of `screen` moved to the top; undefined when none of them is marked. */
export function pinnedRows(screen: number[], marked: (index: number) => boolean): PinnedRows | undefined {
  const top = screen.filter(marked);
  if (top.length === 0) return undefined;
  return { order: [...top, ...screen.filter((i) => !marked(i))], count: top.length };
}

/** `delta` rows on from `selected` in `order`, stopping at the ends; the first row when `selected` is not there. */
export function stepOrder(order: number[], selected: number, delta: number): number | undefined {
  if (order.length === 0) return undefined;
  const at = order.indexOf(selected);
  if (at < 0) return order[0];
  return order[Math.max(0, Math.min(order.length - 1, at + delta))];
}

/** The next marked entry on screen after `selected`, downwards (`dir` 1) or upwards (-1). */
export function nextMarkedIn(order: number[], selected: number, dir: 1 | -1, marked: (index: number) => boolean): number | undefined {
  for (let at = order.indexOf(selected) + dir; at >= 0 && at < order.length; at += dir) if (marked(order[at])) return order[at];
  return undefined;
}

/**
 * Where the selection goes when the pinned entry `index` is unmarked: the
 * pinned row below it, else the one above; undefined when it was the only one,
 * or is not pinned (the selection then stays with the entry).
 */
export function afterUnpin(rows: PinnedRows | undefined, index: number): number | undefined {
  if (!rows) return undefined;
  const at = rows.order.indexOf(index);
  if (at < 0 || at >= rows.count) return undefined;
  if (at + 1 < rows.count) return rows.order[at + 1];
  return at > 0 ? rows.order[at - 1] : undefined;
}
