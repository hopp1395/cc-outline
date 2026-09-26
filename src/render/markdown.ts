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

/** Renders Markdown to ANSI-styled lines no wider than `width` columns. */
export function renderMarkdown(markdown: string, width: number): string[] {
  const w = Math.max(20, width);
  const ansi = rendererFor(w).parse(markdown, { async: false }) as string;
  return ansi.replace(/\n+$/, "").split("\n").flatMap((l) => wrapLine(l, w));
}
