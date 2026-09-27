import stringWidth from "string-width";

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\]8;[^\u0007\u001b]*(\u0007|\u001b\\)/g, "");

/** A web address in plain text; trailing punctuation that usually ends a sentence is not part of it. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`()[\]{}]+[^\s<>"'`()[\]{}.,;:!?]/g;
/** Characters a URL wrapped onto the next line continues with. */
const URL_REST = /^[^\s<>"'`()[\]{}]+/;

interface Span {
  start: number;
  end: number;
  url: string;
}

/** URLs of a plain line, with their columns (display width, so wide characters before them count twice). */
function spans(plain: string): Span[] {
  const found: Span[] = [];
  for (const m of plain.matchAll(URL_PATTERN)) {
    const start = stringWidth(plain.slice(0, m.index));
    found.push({ start, end: start + stringWidth(m[0]), url: m[0] });
  }
  return found;
}

/** Whether a line was cut by wrapping: it fills the pane (wrapping may leave one column free). */
const fills = (plain: string, width: number) => stringWidth(plain.trimEnd()) >= width - 1;

/**
 * The URL at column `col` of line `index` of rendered `lines`, or undefined.
 * Lines are wrapped to `width` columns, so a URL that ends a full line can
 * continue on the next one (after its indentation); every part opens the
 * whole address.
 */
export function linkAt(lines: string[], index: number, col: number, width: number): string | undefined {
  const plain = (i: number) => (i >= 0 && i < lines.length ? stripAnsi(lines[i]) : "");
  const line = plain(index);
  const continuation = (from: number) => {
    let rest = "";
    for (let i = from; i < lines.length; i++) {
      const next = plain(i).trimStart();
      const part = URL_REST.exec(next)?.[0];
      if (!part) break;
      rest += part;
      // Only a part that fills its line can go on further.
      if (part.length < next.trimEnd().length || !fills(plain(i), width)) break;
    }
    return rest;
  };

  for (const span of spans(line)) {
    if (col < span.start || col >= span.end) continue;
    const wrapped = span.end >= stringWidth(line.trimEnd()) && fills(line, width);
    return wrapped ? span.url + continuation(index + 1) : span.url;
  }

  // A click on the wrapped rest of a URL that started on an earlier line.
  const indent = line.length - line.trimStart().length;
  const head = URL_REST.exec(line.trimStart())?.[0];
  if (!head || col < indent || col >= indent + stringWidth(head)) return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const prev = plain(i);
    const last = spans(prev).at(-1);
    if (!fills(prev, width)) return undefined;
    if (last && last.end >= stringWidth(prev.trimEnd())) return last.url + continuation(i + 1);
    // Keep going back only through lines that are themselves pieces of a URL.
    if (URL_REST.exec(prev.trimStart())?.[0] !== prev.trim()) return undefined;
  }
  return undefined;
}
