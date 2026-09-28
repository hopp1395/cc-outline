import { extname } from "node:path";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { DiffLine, ParsedDiff } from "../git/diff.js";
import { highlight } from "./highlight.js";

/** File extension → highlight.js language. Only C# for now; extend as needed. */
const LANGUAGES: Record<string, string> = {
  ".cs": "csharp",
  ".csx": "csharp",
};

export function languageFor(path: string): string | undefined {
  return LANGUAGES[extname(path).toLowerCase()];
}

const BG = {
  add: "\u001b[48;2;30;58;36m",
  del: "\u001b[48;2;72;30;34m",
  ctx: "",
};
const SIGN = { add: "+", del: "-", ctx: " " };
const dim = (s: string) => `\u001b[2m${s}\u001b[22m`;
const cyan = (s: string) => `\u001b[36m${s}\u001b[39m`;

const expandTabs = (s: string) => s.replace(/\t/g, "    ");

function highlightLines(lines: string[], language: string | undefined): string[] {
  if (!language || lines.length === 0) return lines;
  try {
    const out = highlight(lines.join("\n"), language).split("\n");
    return out.length === lines.length ? out : lines;
  } catch {
    return lines;
  }
}

/**
 * Highlights each side of a hunk as one text, so constructs spanning lines
 * (block comments, verbatim strings) are coloured correctly, then maps the
 * results back to the diff lines.
 */
function highlightHunk(lines: DiffLine[], language: string | undefined): string[] {
  const newSide = lines.filter((l) => l.kind !== "del");
  const oldSide = lines.filter((l) => l.kind === "del");
  const newHl = highlightLines(newSide.map((l) => expandTabs(l.text)), language);
  const oldHl = highlightLines(oldSide.map((l) => expandTabs(l.text)), language);
  let n = 0;
  let o = 0;
  return lines.map((l) => (l.kind === "del" ? oldHl[o++] : newHl[n++]));
}

function pad(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - stringWidth(line)));
}

export interface RenderedDiff {
  lines: string[];
  /** Indices of hunk header lines, for jumping between hunks. */
  hunkStarts: number[];
  /** Width of the line-number gutter, which stays in place when scrolling sideways. */
  gutterWidth: number;
}

/**
 * Renders a parsed diff as ANSI lines. With `wrap` they are exactly `width`
 * columns; without, long lines stay whole for horizontal scrolling.
 */
export function renderDiff(diff: ParsedDiff, path: string, width: number, wrap = true): RenderedDiff {
  const lines: string[] = [];
  const hunkStarts: number[] = [];
  if (diff.binary) return { lines: [dim("Binary file changed")], hunkStarts, gutterWidth: 0 };
  if (diff.hunks.length === 0) return { lines: [dim("No content changes")], hunkStarts, gutterWidth: 0 };

  const language = languageFor(path);
  const maxNo = Math.max(
    ...diff.hunks.flatMap((h) => h.lines.map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0))),
  );
  const numWidth = String(maxNo).length;
  const gutterWidth = numWidth * 2 + 4;

  diff.hunks.forEach((hunk, i) => {
    if (i > 0) lines.push("");
    hunkStarts.push(lines.length);
    lines.push(cyan(wrapAnsi(hunk.header, width, { hard: true }).split("\n")[0]));
    const code = highlightHunk(hunk.lines, language);
    hunk.lines.forEach((l, j) => {
      const gutter =
        String(l.oldNo ?? "").padStart(numWidth) + " " + String(l.newNo ?? "").padStart(numWidth) + " ";
      lines.push(...codeRows(dim(gutter) + SIGN[l.kind] + " ", gutterWidth, code[j], width, wrap, BG[l.kind]));
    });
  });
  return { lines, hunkStarts, gutterWidth };
}

/**
 * One code line as rows: gutter prefix, then the code wrapped to `width` or
 * kept whole. A background fills the row to at least `width`.
 */
function codeRows(prefix: string, gutterWidth: number, code: string, width: number, wrap: boolean, bg = ""): string[] {
  const parts = wrap ? wrapAnsi(code, Math.max(10, width - gutterWidth), { hard: true, trim: false }).split("\n") : [code];
  return parts.map((part, k) => {
    const row = (k === 0 ? prefix : " ".repeat(gutterWidth)) + part;
    return bg ? bg + pad(row, width) + "\u001b[49m" : row;
  });
}

/** Line numbers of the new file that the diff adds or changes. */
export function addedLines(diff: ParsedDiff): Set<number> {
  const added = new Set<number>();
  for (const hunk of diff.hunks) for (const l of hunk.lines) if (l.kind === "add") added.add(l.newNo!);
  return added;
}

/**
 * Renders the whole file after the change, highlighted and numbered, without
 * change markers. `hunkStarts` still point at the changed blocks for jumping.
 */
export function renderFile(
  content: string,
  path: string,
  width: number,
  added: Set<number>,
  wrap = true,
): RenderedDiff {
  const source = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (source.at(-1) === "") source.pop();
  const code = highlightLines(source.map(expandTabs), languageFor(path));
  const numWidth = String(source.length).length;
  const gutterWidth = numWidth + 1;
  const lines: string[] = [];
  const hunkStarts: number[] = [];
  code.forEach((c, i) => {
    const no = i + 1;
    if (added.has(no) && !added.has(no - 1)) hunkStarts.push(lines.length);
    lines.push(...codeRows(dim(String(no).padStart(numWidth) + " "), gutterWidth, c, width, wrap));
  });
  return { lines, hunkStarts, gutterWidth };
}
