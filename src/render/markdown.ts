import { Marked, type Tokens } from "marked";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { terminalRenderer, withoutHyperlinks } from "./terminal.js";

const cache = new Map<string, Marked>();

function rendererFor(width: number, wrap: boolean): Marked {
  const key = `${width}:${wrap}`;
  let m = cache.get(key);
  if (!m) {
    m = new Marked();
    m.use(terminalRenderer(width));
    m.use({
      renderer: {
        // Tables are fitted to the width here, since wrapLine would break their
        // borders apart. Unwrapped, they keep their natural width and scroll
        // sideways like the other lines.
        table(token: Tokens.Table) {
          const cells = (row: Tokens.TableCell[]) => row.map((c) => withoutHyperlinks(this.parser.parseInline(c.tokens)));
          const fit = wrap ? width : Infinity;
          return renderTable(cells(token.header), token.rows.map(cells), token.align, fit) + "\n\n";
        },
      },
    });
    cache.set(key, m);
  }
  return m;
}

type Align = "left" | "center" | "right" | null;

const bold = (s: string) => `\u001b[1m${s}\u001b[22m`;
const dim = (s: string) => `\u001b[2m${s}\u001b[22m`;
/** Columns narrower than this (or than their longest word, if shorter) make the table a list. */
const MIN_COLUMN = 15;

/** The parts a word may break into: once more after "-" and "/" ("PASSED-", "WITH-", "GAPS"). */
function pieces(word: string): string[] {
  return word.split(/(?<=[^\s\-/][\-/]+)(?=[^\-/])/);
}

function longestWord(text: string): number {
  const words = text.replace(ANSI, "").split(/\s+/);
  return Math.max(0, ...words.flatMap(pieces).map((w) => stringWidth(w)));
}

/**
 * Wraps a cell's text to `width`, breaking at spaces and after "-" and "/",
 * and inside a piece only if it does not fit on a line of its own. Styles
 * that span a break are closed at the line's end and reopened on the next one.
 */
function wrapCell(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    pieces(word).forEach((piece, i) => {
      const sep = i === 0 && line ? " " : "";
      if (stringWidth(line + sep + piece) <= width) {
        line += sep + piece;
        return;
      }
      if (line) lines.push(line);
      const parts = wrapAnsi(piece, width, { hard: true, trim: false }).split("\n");
      line = parts.pop()!;
      lines.push(...parts);
    });
  }
  lines.push(line);
  let open = "";
  return lines.map((l) => {
    const out = open + l + (open || l.includes("\u001b[") ? "\u001b[0m" : "");
    open += (l.match(ANSI) ?? []).join("");
    return out;
  });
}

function pad(text: string, width: number, align: Align): string {
  const gap = Math.max(0, width - stringWidth(text));
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") return " ".repeat(gap >> 1) + text + " ".repeat(gap - (gap >> 1));
  return text + " ".repeat(gap);
}

/**
 * Column widths that fit `available` columns, or undefined if even the
 * minimum widths do not: each column keeps its natural width, and the widest
 * ones are cut down to a common width until all fit, none below its minimum.
 */
function fitColumns(natural: number[], min: number[], available: number): number[] | undefined {
  const sum = (ws: number[]) => ws.reduce((a, b) => a + b, 0);
  if (sum(natural) <= available) return natural;
  if (sum(min) > available) return undefined;
  const at = (level: number) => natural.map((n, c) => Math.max(min[c], Math.min(n, level)));
  let level = 0;
  while (sum(at(level + 1)) <= available) level++;
  const widths = at(level);
  // Hand the columns left over by the rounding to the cut ones, left to right.
  let spare = available - sum(widths);
  for (let c = 0; c < widths.length && spare > 0; c++) {
    if (widths[c] < natural[c]) {
      widths[c]++;
      spare--;
    }
  }
  return widths;
}

/**
 * Draws a table in a frame no wider than `width`, wrapping the cells' text
 * inside them. A column gets at least the width of its header's longest word
 * and of its longest word (up to MIN_COLUMN); if that does not fit, each row
 * is listed as "header: value" lines instead, like Claude Code does.
 */
export function renderTable(header: string[], rows: string[][], align: Align[], width: number): string {
  const count = header.length;
  const all = [header, ...rows];
  const natural = header.map((_, c) => Math.max(1, ...all.map((r) => stringWidth(r[c] ?? ""))));
  const min = header.map((h, c) => {
    const word = Math.max(0, ...rows.map((r) => longestWord(r[c] ?? "")));
    return Math.min(natural[c], Math.max(longestWord(h), Math.min(MIN_COLUMN, word)));
  });
  const widths = fitColumns(natural, min, width - (3 * count + 1));
  if (!widths) return renderRecords(header, rows, width);

  const line = (l: string, m: string, r: string) => dim(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const row = (cells: string[], style: (s: string) => string = (s) => s) => {
    const wrapped = widths.map((w, c) => wrapCell(cells[c] ?? "", w));
    const height = Math.max(...wrapped.map((w) => w.length));
    return Array.from({ length: height }, (_, i) =>
      dim("│") + wrapped.map((w, c) => ` ${style(pad(w[i] ?? "", widths[c], align[c] ?? null))} `).join(dim("│")) + dim("│"),
    );
  };
  const out = [line("┌", "┬", "┐"), ...row(header, bold)];
  for (const r of rows) out.push(line("├", "┼", "┤"), ...row(r));
  out.push(line("└", "┴", "┘"));
  return out.join("\n");
}

function renderRecords(header: string[], rows: string[][], width: number): string {
  const out: string[] = [];
  rows.forEach((row, r) => {
    if (r > 0) out.push(dim("─".repeat(Math.min(width, 40))));
    header.forEach((name, c) => {
      const text = name.replace(ANSI, "").trim() ? `${bold(`${name}:`)} ${row[c] ?? ""}` : (row[c] ?? "");
      const [first, ...rest] = wrapAnsi(text, width, { hard: true, trim: true }).split("\n");
      const cont = rest.length ? wrapAnsi(rest.join(" "), width - 2, { hard: true, trim: true }).split("\n") : [];
      out.push(first, ...cont.map((l) => "  " + l));
    });
  });
  return out.join("\n");
}

const ANSI = /\u001b\[[0-9;]*m/g;
// Leading indentation plus an optional list marker ("* ", "1. ") or blockquote bar.
const PREFIX = /^(\s*(?:[*•-] |\d+\. |│ ?)?)/;
const LEADING_SPACE = /^((?:\u001b\[[0-9;]*m)*) /;

/** Hard-wraps one line, indenting continuation lines to align with the text after the prefix. */
function wrapLine(line: string, width: number): string[] {
  if (stringWidth(line) <= width) return [line];
  const plain = line.replace(ANSI, "");
  const prefixWidth = stringWidth(PREFIX.exec(plain)?.[1] ?? "");
  const indent = prefixWidth > 0 && prefixWidth < width / 2 ? prefixWidth : 0;
  const [first, ...rest] = wrapAnsi(line, width, { hard: true, trim: false }).split("\n");
  // trim: false keeps the first line's indentation but also the space at each break.
  if (indent === 0) return [first, ...rest.map((l) => l.replace(LEADING_SPACE, "$1"))];
  if (rest.length === 0) return [first];
  // Re-wrap the remainder at the narrower width so the indentation fits.
  const remainder = rest.join(" ").replace(/^\s+/, "");
  const cont = wrapAnsi(remainder, width - indent, { hard: true }).split("\n");
  return [first, ...cont.map((l) => " ".repeat(indent) + l)];
}

/**
 * Renders Markdown to ANSI-styled lines. With `wrap`, no line is wider than
 * `width` columns; without it, paragraphs and code keep their source lines
 * (tables and rules are still sized to `width`).
 */
export function renderMarkdown(markdown: string, width: number, wrap = true): string[] {
  if (markdown.includes(BOX_START) || markdown.includes(BOX_START_CYAN)) return renderWithBoxes(markdown, width, wrap);
  const w = Math.max(20, width);
  const ansi = rendererFor(w, wrap).parse(markdown, { async: false }) as string;
  const lines = ansi.replace(/\n+$/, "").split("\n");
  return wrap ? lines.flatMap((l) => wrapLine(l, w)) : lines;
}

/**
 * Marks a part of the Markdown that is drawn in a frame (Claude's questions):
 * a line of BOX_START, optionally followed by the frame's title, and a line of
 * BOX_END. Private-use characters, so they never occur in real text.
 */
export const BOX_START = "\uE000";
export const BOX_END = "\uE001";
/** A line of its own inside a frame: drawn as a dimmed rule across it. */
export const BOX_RULE = "\uE002";
/** Starts a frame like BOX_START, drawn in cyan instead of yellow (browser actions). */
export const BOX_START_CYAN = "\uE003";
const BOX = /([\uE000\uE003])([^\n]*)\n([\s\S]*?)\n?\uE001/g;

/** `markdown` without the frame marks and the colours inside frames, e.g. for copying. */
export function stripBoxes(markdown: string): string {
  return markdown
    .replace(BOX, "$3")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\n\n\uE002\n\n/g, "\n\n---\n\n")
    .replace(/\u00a0/g, " ");
}

const yellow = (s: string) => `\u001b[33m${s}\u001b[39m`;
const cyan = (s: string) => `\u001b[36m${s}\u001b[39m`;

/** Renders the parts between the marks narrower, inside a frame open to the right, and the rest as usual. */
function renderWithBoxes(markdown: string, width: number, wrap: boolean): string[] {
  const w = Math.max(20, width);
  const lines: string[] = [];
  const plain = (md: string) => {
    if (md.trim()) lines.push(...(lines.length ? [""] : []), ...renderMarkdown(md, w, wrap));
  };
  let at = 0;
  for (const m of markdown.matchAll(BOX)) {
    plain(markdown.slice(at, m.index));
    at = m.index + m[0].length;
    const colour = m[1] === BOX_START_CYAN ? cyan : yellow;
    const title = m[2].trim();
    const top = `╭─${title ? ` ${title} ` : ""}`;
    if (lines.length) lines.push("");
    lines.push(colour(top + "─".repeat(Math.max(0, w - stringWidth(top)))));
    for (const line of renderMarkdown(m[3], w - 2, wrap)) {
      const rule = line.replace(ANSI, "").trim() === BOX_RULE;
      lines.push(`${colour("│")} ${rule ? `\u001b[2m${"┄".repeat(w - 2)}\u001b[22m` : line}`);
    }
    lines.push(colour("╰" + "─".repeat(w - 1)));
  }
  plain(markdown.slice(at));
  return lines;
}

