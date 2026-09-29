/**
 * The list filter (Ctrl+F): which entries of a list match a typed text, and
 * the editing of that text in the filter dialog.
 */

/** Whether an entry's text (its fields joined by newlines) matches. */
export type Matcher = (haystack: string) => boolean;

const SPECIAL = /[.+^${}()|[\]\\]/;

/** One word as a pattern: `*` any run of characters, `?` and `_` one character, within one field. */
function wordPattern(word: string): RegExp {
  let source = "";
  for (const c of word) {
    if (c === "*") source += "[^\\n]*";
    else if (c === "?" || c === "_") source += "[^\\n]";
    else source += SPECIAL.test(c) ? `\\${c}` : c;
  }
  return new RegExp(source, "i");
}

/**
 * The matcher of a filter text, or undefined when it has no words (no
 * filter). Case is ignored; every word must occur somewhere in the text, in
 * any order and any field.
 */
export function compileFilter(query: string): Matcher | undefined {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  const patterns = words.map(wordPattern);
  return (haystack) => patterns.every((p) => p.test(haystack));
}

/** An entry's text to filter by: its fields, one per line, so that wildcards stay within a field. */
export function haystack(fields: (string | undefined)[]): string {
  return fields.filter((f): f is string => !!f).map((f) => f.replace(/\n/g, " ")).join("\n");
}

/** What an entry is found by: what its list row shows, and what its details add. */
export interface FilterText {
  list: string;
  details: string;
}

/** The part of the filter setting a key switches: ^L the list, ^D the details. Never both off. */
export function toggleFilterIn(current: "list" | "details" | "both", part: "list" | "details"): "list" | "details" | "both" {
  const other = part === "list" ? "details" : "list";
  // Off: add it. On: leave the other, which comes on if it was off.
  return current === other ? "both" : other;
}

/** The indexes of the texts that match. */
export function filterIndices(texts: string[], match: Matcher): number[] {
  const shown: number[] = [];
  texts.forEach((text, i) => {
    if (match(text)) shown.push(i);
  });
  return shown;
}

/**
 * The entry to select when the filter changes: `selected` if it is shown,
 * else the nearest shown one before it, else the first. Undefined when none is shown.
 */
export function nearestShown(shown: number[], selected: number): number | undefined {
  let before: number | undefined;
  for (const i of shown) {
    if (i === selected) return i;
    if (i < selected) before = i;
    else break;
  }
  return before ?? shown[0];
}

/**
 * A step through the shown entries: `delta` entries on from `selected`
 * (which may be hidden), stopping at the ends.
 */
export function stepShown(shown: number[], selected: number, delta: number): number | undefined {
  if (shown.length === 0) return undefined;
  // Where `selected` is, or would be, among the shown entries.
  let at = shown.findIndex((i) => i >= selected);
  if (at < 0) at = shown.length;
  const exact = shown[at] === selected;
  const target = delta > 0 ? at + delta - (exact ? 0 : 1) : at + delta;
  return shown[Math.max(0, Math.min(shown.length - 1, target))];
}

/** The text of the filter dialog: its cursor and whether all of it is selected (typing replaces it). */
export interface LineState {
  text: string;
  cursor: number;
  selected: boolean;
}

/** The keys editLine reads, as Ink's useInput reports them. */
export interface LineKey {
  leftArrow?: boolean;
  rightArrow?: boolean;
  home?: boolean;
  end?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/** A line with all of `text` selected, the cursor at its end. */
export const lineOf = (text: string): LineState => ({ text, cursor: text.length, selected: text.length > 0 });

/** Text to insert: line breaks and other control characters become spaces. */
export const insertable = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, " ");

/**
 * Edits the line for one key: characters (also a pasted string) insert at the
 * cursor or replace the selected text, Backspace/Delete remove one character or the
 * selection, ←→ and Home/End move the cursor, Ctrl+U clears. Other keys return `state` itself.
 */
export function editLine(state: LineState, input: string, key: LineKey): LineState {
  const { text, cursor, selected } = state;
  if (key.ctrl && input === "u") return { text: "", cursor: 0, selected: false };
  if (key.backspace || key.delete) {
    if (selected) return { text: "", cursor: 0, selected: false };
    if (key.backspace) return cursor > 0 ? { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1, selected: false } : state;
    return cursor < text.length ? { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor, selected: false } : state;
  }
  if (key.leftArrow) return { text, cursor: selected ? 0 : Math.max(0, cursor - 1), selected: false };
  if (key.rightArrow) return { text, cursor: selected ? text.length : Math.min(text.length, cursor + 1), selected: false };
  if (key.home) return { text, cursor: 0, selected: false };
  if (key.end) return { text, cursor: text.length, selected: false };
  if (key.ctrl || key.meta || !input) return state;
  // Mouse and focus reports reach useInput without their ESC; they are not text.
  if (input.startsWith("[<") || input === "[I" || input === "[O") return state;
  const add = insertable(input);
  if (selected) return { text: add, cursor: add.length, selected: false };
  return { text: text.slice(0, cursor) + add + text.slice(cursor), cursor: cursor + add.length, selected: false };
}
