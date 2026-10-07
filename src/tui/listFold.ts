import { isListFold, stepListWidth, type ColumnWidth, type ListFold, type ListWidth } from "../settings.js";

export type { ListFold };

/**
 * What a view keeps about its fold while the viewer runs, beside the stored width: `last`, the end
 * reached last (the next `|` from a width goes to the other one), and `drilled` while a detail opened
 * from the full list shows the preview over the whole pane.
 */
export interface FoldState {
  last: ListFold;
  drilled: boolean;
}

export const UNFOLDED: FoldState = { last: "full", drilled: false };

/** What the pane shows for the stored `width`: a detail opened from the full list hides the list instead. */
export function shownFold(width: ListWidth, state: FoldState): ListFold | undefined {
  if (state.drilled) return "hidden";
  return isListFold(width) ? width : undefined;
}

/** The width next to an end: what `|` goes back to when the width before it is not known. */
const besideEnd = (fold: ListFold): ColumnWidth => (fold === "hidden" ? "narrow" : "wider");

/**
 * `|`: from either end back to `before` (the width shown before it, if known, else the one next to
 * the end), from a width to the end not reached last.
 */
export function toggleFold(width: ListWidth, state: FoldState, before?: ColumnWidth): { width: ListWidth; state: FoldState } {
  const shown = shownFold(width, state);
  if (shown) return { width: isListFold(width) ? (before ?? besideEnd(width)) : width, state: { last: shown, drilled: false } };
  const next = state.last === "hidden" ? "full" : "hidden";
  return { width: next, state: { last: next, drilled: false } };
}

/**
 * `<` and `>` on the scale `hidden` < narrow … wider < `full`, stopping at the ends. A drilled detail
 * counts as `hidden`. The result is the width to store and show, unchanged at an end.
 */
export function stepFold(width: ListWidth, state: FoldState, step: 1 | -1): { width: ListWidth; state: FoldState } {
  const from = shownFold(width, state) === "hidden" ? "hidden" : width;
  const next = stepListWidth(from, step);
  if (next === width && !state.drilled) return { width, state };
  return { width: next, state: { last: isListFold(next) ? next : state.last, drilled: false } };
}

/**
 * A view's detail opened or closed (`was`: open before): opened from the full list, it shows over the
 * whole pane until it closes. One left open while the list went full stays out of sight.
 */
export function detailFold(width: ListWidth, state: FoldState, open: boolean, was: boolean): FoldState {
  const drilled = open && (state.drilled || (!was && width === "full"));
  return drilled === state.drilled ? state : { ...state, drilled };
}
