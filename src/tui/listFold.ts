import { LIST_WIDTH_VALUES, stepListWidth, type ListWidth } from "../settings.js";

/** A list folded away (`hidden`: the preview takes the pane) or spread over the pane (`full`: no preview). */
export type ListFold = "hidden" | "full";

/**
 * A view's fold, kept while the viewer runs and never stored: `fold` as `|`, `<` and `>` left it,
 * `last` the end reached last (the next `|` from the set width goes to the other one),
 * `drilled` while a detail opened from the full list shows the preview over the whole pane.
 */
export interface FoldState {
  fold?: ListFold;
  last: ListFold;
  drilled: boolean;
}

export const UNFOLDED: FoldState = { last: "full", drilled: false };

/** What the pane shows: a detail opened from the full list hides the list instead. */
export function shownFold(state: FoldState): ListFold | undefined {
  return state.drilled ? "hidden" : state.fold;
}

/** `|`: from either end back to the set width, from there to the end not reached last. */
export function toggleFold(state: FoldState): FoldState {
  const shown = shownFold(state);
  if (shown) return { last: shown, drilled: false };
  const next = state.last === "hidden" ? "full" : "hidden";
  return { fold: next, last: next, drilled: false };
}

/**
 * `<` and `>` on one scale, `hidden` < narrow … wider < `full`, stopping at the ends. Leaving an end
 * sets the width next to it; `width` is the one to store, unchanged at the ends.
 */
export function stepFold(state: FoldState, width: ListWidth, step: 1 | -1): { state: FoldState; width: ListWidth; shown: ListFold | ListWidth } {
  const shown = shownFold(state);
  if (shown === "hidden" || shown === "full") {
    if ((shown === "hidden") === (step === -1)) return { state, width, shown };
    const next = shown === "hidden" ? LIST_WIDTH_VALUES[0] : LIST_WIDTH_VALUES[LIST_WIDTH_VALUES.length - 1];
    return { state: { last: shown, drilled: false }, width: next, shown: next };
  }
  const next = stepListWidth(width, step);
  if (next !== width) return { state, width: next, shown: next };
  const fold = step === -1 ? "hidden" : "full";
  return { state: { fold, last: fold, drilled: false }, width, shown: fold };
}

/**
 * A view's detail opened or closed (`was`: open before): opened from the full list, it shows over the
 * whole pane until it closes. One left open while the list went full stays out of sight.
 */
export function detailFold(state: FoldState, open: boolean, was: boolean): FoldState {
  const drilled = open && (state.drilled || (!was && state.fold === "full"));
  return drilled === state.drilled ? state : { ...state, drilled };
}
