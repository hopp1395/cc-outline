import { extname } from "node:path";
import { highlight, type Theme } from "cli-highlight";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { DiffLine, ParsedDiff } from "../git/diff.js";

/** File extension → highlight.js language. Only C# for now; extend as needed. */
const LANGUAGES: Record<string, string> = {
  ".cs": "csharp",
  ".csx": "csharp",
};

export function languageFor(path: string): string | undefined {
  return LANGUAGES[extname(path).toLowerCase()];
}

// Styles are applied per line: the output is split into lines afterwards, so a
// token spanning lines (block comment) must be reopened on each of them.
const style = (open: string, close: string) => (s: string) =>
  s
    .split("\n")
    .map((l) => `\u001b[${open}m${l}\u001b[${close}m`)
    .join("\n");
const fg = (code: string) => style(code, "39");
const bold = style("1", "22");
const italic = style("3", "23");

// Truecolor palette that stays readable on the green/red diff backgrounds.
const THEME: Theme = {
  keyword: fg("38;2;86;156;214"),
  built_in: fg("38;2;78;201;176"),
  type: fg("38;2;78;201;176"),
  class: fg("38;2;78;201;176"),
  title: fg("38;2;220;220;170"),
  function: fg("38;2;220;220;170"),
  string: fg("38;2;206;145;120"),
  subst: fg("38;2;212;212;212"),
  number: fg("38;2;181;206;168"),
  literal: fg("38;2;86;156;214"),
  comment: (s) => italic(fg("38;2;106;153;85")(s)),
  doctag: fg("38;2;96;139;78"),
  meta: fg("38;2;155;155;155"),
  "meta-keyword": fg("38;2;197;134;192"),
  "meta-string": fg("38;2;206;145;120"),
  attr: fg("38;2;156;220;254"),
  params: fg("38;2;156;220;254"),
  variable: fg("38;2;156;220;254"),
  section: bold,
};

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
    const out = highlight(lines.join("\n"), { language, ignoreIllegals: true, theme: THEME }).split("\n");
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
}

/** Renders a parsed diff as ANSI lines of exactly `width` columns. */
export function renderDiff(diff: ParsedDiff, path: string, width: number): RenderedDiff {
  const lines: string[] = [];
  const hunkStarts: number[] = [];
  if (diff.binary) return { lines: [dim("Binary file changed")], hunkStarts };
  if (diff.hunks.length === 0) return { lines: [dim("No content changes")], hunkStarts };

  const language = languageFor(path);
  const maxNo = Math.max(
    ...diff.hunks.flatMap((h) => h.lines.map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0))),
  );
  const numWidth = String(maxNo).length;
  const gutterWidth = numWidth * 2 + 4;
  const codeWidth = Math.max(10, width - gutterWidth);

  diff.hunks.forEach((hunk, i) => {
    if (i > 0) lines.push("");
    hunkStarts.push(lines.length);
    lines.push(cyan(wrapAnsi(hunk.header, width, { hard: true }).split("\n")[0]));
    const code = highlightHunk(hunk.lines, language);
    hunk.lines.forEach((l, j) => {
      const gutter =
        String(l.oldNo ?? "").padStart(numWidth) + " " + String(l.newNo ?? "").padStart(numWidth) + " ";
      const wrapped = wrapAnsi(code[j], codeWidth, { hard: true, trim: false }).split("\n");
      wrapped.forEach((part, k) => {
        const prefix = k === 0 ? dim(gutter) + SIGN[l.kind] + " " : " ".repeat(gutterWidth);
        const bg = BG[l.kind];
        const row = prefix + part;
        lines.push(bg ? bg + pad(row, width) + "\u001b[49m" : row);
      });
    });
  });
  return { lines, hunkStarts };
}
