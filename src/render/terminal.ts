import type { MarkedExtension, Tokens } from "marked";
import { hasLanguage, highlight } from "./highlight.js";

/**
 * An SGR style. Like chalk, it reopens itself after a nested close of the
 * same attribute and closes at each line end, so the lines can be split,
 * indented and wrapped afterwards.
 */
const sgr = (open: string, close: string) => {
  const on = `\u001b[${open}m`;
  const off = `\u001b[${close}m`;
  return (s: string) =>
    s
      .split("\n")
      .map((l) => (l ? on + l.replaceAll(off, off + on) + off : l))
      .join("\n");
};
const compose =
  (...styles: ((s: string) => string)[]) =>
  (s: string) =>
    styles.reduceRight((acc, f) => f(acc), s);

const bold = sgr("1", "22");
const dim = sgr("2", "22");
const italic = sgr("3", "23");
const underline = sgr("4", "24");
const strike = sgr("9", "29");
const magenta = sgr("35", "39");
const green = sgr("32", "39");
const yellow = sgr("33", "39");
const blue = sgr("34", "39");
const gray = sgr("90", "39");

const STYLE = {
  firstHeading: compose(magenta, underline, bold),
  heading: compose(green, bold),
  blockquote: compose(gray, italic),
  html: gray,
  code: yellow,
  codespan: yellow,
  strong: bold,
  em: italic,
  del: compose(dim, gray, strike),
  link: blue,
  href: compose(blue, underline),
};

/** Indentation of code blocks, block quotes and top-level lists. */
const TAB = "  ";

const section = (text: string) => text + "\n\n";
const indent = (text: string, by: string) =>
  text
    .split("\n")
    .map((l) => (l ? by + l : l))
    .join("\n");

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** Whether the terminal shows OSC 8 hyperlinks (the cases of the `supports-hyperlinks` package). */
function supportsHyperlinks(env = process.env): boolean {
  const force = env.FORCE_HYPERLINK;
  if (force !== undefined) return !(force.length > 0 && parseInt(force, 10) === 0);
  if (!process.stdout.isTTY) return false;
  if ("WT_SESSION" in env) return true;
  if (process.platform === "win32" || env.CI || env.TEAMCITY_VERSION) return false;
  const [major = 0, minor = 0] = (env.TERM_PROGRAM_VERSION ?? "").split(".").map((n) => parseInt(n, 10) || 0);
  switch (env.TERM_PROGRAM) {
    case "iTerm.app":
      return major > 3 || (major === 3 && minor >= 1);
    case "WezTerm":
      return major >= 20200620;
    case "vscode":
      return major > 1 || (major === 1 && minor >= 72);
    case "ghostty":
      return true;
  }
  const vte = env.VTE_VERSION;
  if (vte) {
    if (vte === "0.50.0") return false;
    // "5402" means 0.54.2
    const [vMajor = 0, vMinor = 0] = /^\d{3,4}$/.test(vte) ? [0, parseInt(vte.slice(0, -2), 10)] : vte.split(".").map(Number);
    return vMajor > 0 || vMinor >= 50;
  }
  return env.TERM === "alacritty";
}

const hyperlinks = supportsHyperlinks();

const OSC8_LINK = /\u001b\]8;;([^\u0007]*)\u0007([\s\S]*?)\u001b\]8;;\u0007/g;

/**
 * `text` with its OSC 8 hyperlinks written out as "text (url)", as without
 * hyperlink support. For table cells: they break after "/" and "-", which
 * would cut the escape sequence apart.
 */
export function withoutHyperlinks(text: string): string {
  return text.replace(OSC8_LINK, (_, url: string, label: string) =>
    label.replace(/\u001b\[[0-9;]*m/g, "") === url ? label : `${label} (${STYLE.href(url)})`,
  );
}

function highlightCode(code: string, lang: string | undefined): string {
  try {
    if (!lang) return highlight(code, undefined);
    if (hasLanguage(lang)) return highlight(code, lang);
  } catch {
    // fall through to the plain style
  }
  return STYLE.code(code);
}

/**
 * Renders Markdown for the terminal: headings with their `#`s, lists with
 * `*` and numbers, quotes and code indented, code highlighted. Replaces
 * marked-terminal and keeps its look; `width` sizes the rules.
 */
export function terminalRenderer(width: number): MarkedExtension {
  let listDepth = 0;
  return {
    renderer: {
      space: () => "",
      text(token: Tokens.Text | Tokens.Escape) {
        // Tight list items hand a text token with nested inline tokens.
        if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
        return token.type === "escape" ? token.text : unescape(token.text);
      },
      code: ({ text, lang }: Tokens.Code) => section(indent(highlightCode(text, lang?.split(/\s/)[0]), TAB)),
      blockquote({ tokens }: Tokens.Blockquote) {
        return section(STYLE.blockquote(indent(this.parser.parse(tokens).replace(/^\n+|\s+$/g, ""), TAB)));
      },
      html: ({ text, block }: Tokens.HTML | Tokens.Tag) => (block ? section(STYLE.html(text.trimEnd())) : STYLE.html(text)),
      heading({ tokens, depth }: Tokens.Heading) {
        const text = "#".repeat(depth) + " " + this.parser.parseInline(tokens);
        return section(depth === 1 ? STYLE.firstHeading(text) : STYLE.heading(text));
      },
      hr: () => section("-".repeat(width)),
      paragraph({ tokens }: Tokens.Paragraph) {
        return section(this.parser.parseInline(tokens));
      },
      list(token: Tokens.List) {
        listDepth++;
        const start = typeof token.start === "number" ? token.start : 1;
        const items = token.items.map((item, i) => {
          const marker = token.ordered ? `${start + i}. ` : "* ";
          const box = item.task ? `[${item.checked ? "X" : " "}] ` : "";
          // One block after the other: a tight item's text has no line break before a nested list.
          const [first = "", ...rest] = item.tokens
            .map((t) => this.parser.parse([t], !!item.loose))
            .join("\n")
            .split("\n")
            .filter((l) => l.trim());
          return [marker + box + first, ...rest.map((l) => " ".repeat(marker.length) + l)].join("\n");
        });
        listDepth--;
        const body = items.join("\n");
        return listDepth === 0 ? section(indent(body, TAB)) : body + "\n";
      },
      strong({ tokens }: Tokens.Strong) {
        return STYLE.strong(this.parser.parseInline(tokens));
      },
      em({ tokens }: Tokens.Em) {
        return STYLE.em(this.parser.parseInline(tokens));
      },
      codespan: ({ text }: Tokens.Codespan) => STYLE.codespan(unescape(text)),
      br: () => "\n",
      del({ tokens }: Tokens.Del) {
        return STYLE.del(this.parser.parseInline(tokens));
      },
      link({ href, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        if (hyperlinks) return STYLE.link(`\u001b]8;;${href.replace(/\+/g, "%20")}\u0007${STYLE.href(text || href)}\u001b]8;;\u0007`);
        const hasText = text && text !== href;
        return STYLE.link((hasText ? `${text} (` : "") + STYLE.href(href) + (hasText ? ")" : ""));
      },
      image: ({ href, title, text }: Tokens.Image) => `![${text}${title ? ` – ${title}` : ""}](${href})`,
    },
  };
}
