import hljs from "highlight.js";

/** Scope name ("keyword", "title.class", …) → style for text of that scope. */
export type Theme = Record<string, (s: string) => string>;

// Styles are applied per line: the output is split into lines afterwards, so a
// token spanning lines (block comment) must be reopened on each of them.
const style = (open: string, close: string) => (s: string) =>
  s
    .split("\n")
    .map((l) => (l ? `\u001b[${open}m${l}\u001b[${close}m` : l))
    .join("\n");
const fg = (code: string) => style(code, "39");
const bold = style("1", "22");
const italic = style("3", "23");
const underline = style("4", "24");

/** Truecolor palette (VS Code Dark+) that stays readable on the green/red diff backgrounds. */
export const THEME: Theme = {
  keyword: fg("38;2;86;156;214"),
  built_in: fg("38;2;78;201;176"),
  type: fg("38;2;78;201;176"),
  "title.class": fg("38;2;78;201;176"),
  title: fg("38;2;220;220;170"),
  function: fg("38;2;220;220;170"),
  string: fg("38;2;206;145;120"),
  regexp: fg("38;2;209;105;105"),
  subst: fg("38;2;212;212;212"),
  number: fg("38;2;181;206;168"),
  literal: fg("38;2;86;156;214"),
  symbol: fg("38;2;86;156;214"),
  comment: (s) => italic(fg("38;2;106;153;85")(s)),
  doctag: fg("38;2;96;139;78"),
  meta: fg("38;2;155;155;155"),
  tag: fg("38;2;128;128;128"),
  name: fg("38;2;86;156;214"),
  attr: fg("38;2;156;220;254"),
  attribute: fg("38;2;156;220;254"),
  params: fg("38;2;156;220;254"),
  variable: fg("38;2;156;220;254"),
  property: fg("38;2;156;220;254"),
  "selector-tag": fg("38;2;215;186;125"),
  "selector-class": fg("38;2;215;186;125"),
  "selector-id": fg("38;2;215;186;125"),
  bullet: fg("38;2;103;150;230"),
  addition: fg("38;2;181;206;168"),
  deletion: fg("38;2;206;145;120"),
  section: bold,
  strong: bold,
  emphasis: italic,
  link: underline,
};

export function hasLanguage(language: string): boolean {
  return hljs.getLanguage(language) !== undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e: string) => ENTITIES[e]);

/** `hljs-title class_` → "title.class". */
function scopeOf(classes: string): string {
  return classes
    .split(" ")
    .map((c) => c.replace(/^hljs-/, "").replace(/_+$/, ""))
    .join(".");
}

/** The theme's style for a scope, trying "title.class.inherited", then "title.class", then "title". */
function styleFor(scope: string, theme: Theme): ((s: string) => string) | undefined {
  for (let parts = scope.split("."); parts.length > 0; parts = parts.slice(0, -1)) {
    const s = theme[parts.join(".")];
    if (s) return s;
  }
  return undefined;
}

/**
 * Turns highlight.js's HTML (nested `<span class="hljs-…">`) into ANSI text.
 * Each run of text takes the style of its innermost scope that the theme
 * knows, so an outer colour continues after a nested token.
 */
function toAnsi(html: string, theme: Theme): string {
  const stack: (((s: string) => string) | undefined)[] = [];
  let out = "";
  for (const m of html.matchAll(/<span class="([^"]*)">|<\/span>|[^<]+/g)) {
    if (m[1] !== undefined) stack.push(styleFor(scopeOf(m[1]), theme) ?? stack[stack.length - 1]);
    else if (m[0] === "</span>") stack.pop();
    else {
      const text = unescape(m[0]);
      const s = stack[stack.length - 1];
      out += s ? s(text) : text;
    }
  }
  return out;
}

/**
 * Highlights `code` as ANSI text. Without a language it is detected; an
 * unknown language throws, like highlight.js does.
 */
export function highlight(code: string, language: string | undefined, theme: Theme = THEME): string {
  const result = language
    ? hljs.highlight(code, { language, ignoreIllegals: true })
    : hljs.highlightAuto(code);
  return toAnsi(result.value, theme);
}
