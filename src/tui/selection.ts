import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import { stripAnsi } from "./links.js";

/** A cell of the preview's lines: the line's index and a column of it before scrolling sideways. */
export interface Point {
  line: number;
  col: number;
}

/**
 * Text selected with the mouse in the preview, from where the drag started
 * (`anchor`) to where the mouse is (`focus`), both cells included. With
 * `from` set, every line is selected from that column on: a drag that starts
 * right of a gutter (line numbers) leaves the gutter out.
 */
export interface Selection {
  anchor: Point;
  focus: Point;
  from: number;
}

const before = (a: Point, b: Point) => a.line < b.line || (a.line === b.line && a.col < b.col);

/** The selection's first and last cell, in the order of the lines. */
export function orderedEnds(sel: Selection): [Point, Point] {
  return before(sel.focus, sel.anchor) ? [sel.focus, sel.anchor] : [sel.anchor, sel.focus];
}

/** Columns of line `index` that are selected, `[start, end)`, or undefined when none are. */
export function selectedColumns(sel: Selection, index: number): [number, number] | undefined {
  const [start, end] = orderedEnds(sel);
  if (index < start.line || index > end.line) return undefined;
  const from = Math.max(sel.from, index === start.line ? start.col : 0);
  const to = index === end.line ? end.col + 1 : Infinity;
  return to > from ? [from, to] : undefined;
}

const INVERSE_ON = "\u001b[7m";
const INVERSE_OFF = "\u001b[27m";

/**
 * `line` with columns `[from, to)` shown inverted, without their colours so
 * that nested resets cannot end the inversion early. An empty part (a blank
 * line inside the selection) shows as one inverted space.
 */
export function highlightColumns(line: string, from: number, to: number): string {
  const width = stringWidth(stripAnsi(line));
  const part = stripAnsi(sliceAnsi(line, from, Math.min(to, width)));
  if (!part && from < width) return line;
  const rest = to < width ? sliceAnsi(line, to) : "";
  return sliceAnsi(line, 0, from) + INVERSE_ON + (part || " ") + INVERSE_OFF + rest;
}

/** The selected text of `lines`, without colours or trailing spaces, one line per preview line. */
export function selectedText(lines: string[], sel: Selection): string {
  const [start, end] = orderedEnds(sel);
  const parts: string[] = [];
  for (let i = start.line; i <= end.line && i < lines.length; i++) {
    const cols = selectedColumns(sel, i);
    const plain = stripAnsi(lines[i]);
    parts.push(cols ? sliceAnsi(plain, cols[0], Math.min(cols[1], stringWidth(plain))).trimEnd() : "");
  }
  return parts.join("\n");
}
