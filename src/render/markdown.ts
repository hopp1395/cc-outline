import { Marked, type Tokens } from "marked";
import { markedTerminal } from "marked-terminal";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

const cache = new Map<number, Marked>();

function rendererFor(width: number): Marked {
  let m = cache.get(width);
  if (!m) {
    m = new Marked();
    // marked-terminal's typings lag behind marked's extension type
    m.use(markedTerminal({ width, reflowText: false, tab: 2, emoji: false }) as never);
    // marked >= 13 hands list items a text token with nested inline tokens that
    // marked-terminal prints verbatim, leaving **bold** and `code` unrendered.
    m.use({
      renderer: {
        text(token: Tokens.Text | Tokens.Escape) {
          if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
          return false;
        },
      },
    });
    cache.set(width, m);
  }
  return m;
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
  if (markdown.includes(BOX_START)) return renderWithBoxes(markdown, width, wrap);
  const w = Math.max(20, width);
  const ansi = rendererFor(w).parse(markdown, { async: false }) as string;
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
const BOX = /\uE000([^\n]*)\n([\s\S]*?)\n?\uE001/g;

/** `markdown` without the frame marks and the colours inside frames, e.g. for copying. */
export function stripBoxes(markdown: string): string {
  return markdown
    .replace(BOX, "$2")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\n\n\uE002\n\n/g, "\n\n---\n\n")
    .replace(/\u00a0/g, " ");
}

const yellow = (s: string) => `\u001b[33m${s}\u001b[39m`;

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
    const title = m[1].trim();
    const top = `╭─${title ? ` ${title} ` : ""}`;
    if (lines.length) lines.push("");
    lines.push(yellow(top + "─".repeat(Math.max(0, w - stringWidth(top)))));
    for (const line of renderMarkdown(m[2], w - 2, wrap)) {
      const rule = line.replace(ANSI, "").trim() === BOX_RULE;
      lines.push(`${yellow("│")} ${rule ? `\u001b[2m${"┄".repeat(w - 2)}\u001b[22m` : line}`);
    }
    lines.push(yellow("╰" + "─".repeat(w - 1)));
  }
  plain(markdown.slice(at));
  return lines;
}

