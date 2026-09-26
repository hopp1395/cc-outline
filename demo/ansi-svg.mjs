// Turns terminal frames (lines with ANSI SGR codes) into an SVG: one frame as a
// still image, or several as a looping animation.
import stringWidth from "string-width";

const CELL_W = 8.4;
const CELL_H = 18;
const FONT_SIZE = 14;
const PAD = 16;
const TITLE_H = 32;

const THEME = {
  background: "#16181d",
  foreground: "#d4d4d4",
  // Standard and bright ANSI colors (One Dark–like).
  ansi: [
    "#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d4d4d4",
    "#5c6370", "#f08c95", "#b5e08f", "#f0d49b", "#82c4ff", "#d99bea", "#7fd1dc", "#ffffff",
  ],
};

function xterm256(n) {
  if (n < 16) return THEME.ansi[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return rgb(v, v, v);
  }
  const i = n - 16;
  const level = (x) => (x === 0 ? 0 : 55 + x * 40);
  return rgb(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6));
}

const rgb = (r, g, b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

const initialStyle = () => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });

function applySgr(style, params) {
  const codes = params === "" ? [0] : params.split(";").map(Number);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) Object.assign(style, initialStyle());
    else if (c === 1) style.bold = true;
    else if (c === 2) style.dim = true;
    else if (c === 3) style.italic = true;
    else if (c === 4) style.underline = true;
    else if (c === 7) style.inverse = true;
    else if (c === 22) style.bold = style.dim = false;
    else if (c === 23) style.italic = false;
    else if (c === 24) style.underline = false;
    else if (c === 27) style.inverse = false;
    else if (c >= 30 && c <= 37) style.fg = THEME.ansi[c - 30];
    else if (c >= 90 && c <= 97) style.fg = THEME.ansi[c - 90 + 8];
    else if (c >= 40 && c <= 47) style.bg = THEME.ansi[c - 40];
    else if (c >= 100 && c <= 107) style.bg = THEME.ansi[c - 100 + 8];
    else if (c === 39) style.fg = null;
    else if (c === 49) style.bg = null;
    else if (c === 38 || c === 48) {
      const key = c === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5) {
        style[key] = xterm256(codes[i + 2]);
        i += 2;
      } else if (codes[i + 1] === 2) {
        style[key] = rgb(codes[i + 2], codes[i + 3], codes[i + 4]);
        i += 4;
      }
    }
  }
}

/** Splits one line into cells: { col, ch, width, style }. */
function parseLine(line) {
  const cells = [];
  const style = initialStyle();
  let col = 0;
  // SGR, other CSI sequences and OSC (e.g. hyperlinks) are recognised; only SGR changes the style.
  const token = /\u001b\[([0-9;?]*)([A-Za-z])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|([^\u001b]+)/g;
  for (const m of line.matchAll(token)) {
    if (m[2] === "m") applySgr(style, m[1]);
    if (m[3] === undefined) continue;
    for (const ch of m[3]) {
      const width = stringWidth(ch);
      if (width === 0) continue;
      cells.push({ col, ch, width, style: { ...style } });
      col += width;
    }
  }
  return cells;
}

const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function colors(style) {
  let fg = style.fg ?? THEME.foreground;
  let bg = style.bg;
  if (style.inverse) [fg, bg] = [bg ?? THEME.background, fg];
  return { fg, bg };
}

/** SVG elements for one frame, positioned in the terminal area. */
function renderFrame(lines) {
  const rects = [];
  const texts = [];
  lines.forEach((line, row) => {
    const y = row * CELL_H;
    const cells = parseLine(line);
    // Backgrounds, merged into runs of the same color.
    let run = null;
    const flush = () => {
      if (run) rects.push(`<rect x="${run.x.toFixed(1)}" y="${y}" width="${run.w.toFixed(1)}" height="${CELL_H}" fill="${run.bg}"/>`);
      run = null;
    };
    for (const cell of cells) {
      const { bg } = colors(cell.style);
      const x = cell.col * CELL_W;
      const w = cell.width * CELL_W;
      if (bg && run && run.bg === bg && Math.abs(run.x + run.w - x) < 0.01) run.w += w;
      else {
        flush();
        if (bg) run = { x, w, bg };
      }
    }
    flush();

    // Text: ASCII in runs of one style, other characters one by one so a
    // fallback font's width cannot shift the grid.
    let text = null;
    const key = (s) => JSON.stringify([colors(s).fg, s.bold, s.dim, s.italic, s.underline]);
    const flushText = () => {
      if (!text) return;
      const s = text.style;
      const attrs = [
        `x="${text.x.toFixed(1)}"`,
        `y="${y + CELL_H - 5}"`,
        `fill="${colors(s).fg}"`,
        `textLength="${(text.cols * CELL_W).toFixed(1)}"`,
        `lengthAdjust="spacingAndGlyphs"`,
      ];
      if (s.bold) attrs.push(`font-weight="bold"`);
      if (s.dim) attrs.push(`fill-opacity="0.55"`);
      if (s.italic) attrs.push(`font-style="italic"`);
      if (s.underline) attrs.push(`text-decoration="underline"`);
      texts.push(`<text ${attrs.join(" ")}>${escapeXml(text.chars)}</text>`);
      text = null;
    };
    for (const cell of cells) {
      // Spaces only advance the position; renderers collapse them inside <text>.
      if (cell.ch === " ") {
        flushText();
        continue;
      }
      const ascii = cell.ch.charCodeAt(0) < 128;
      if (ascii && text && text.ascii && text.key === key(cell.style)) {
        text.chars += cell.ch;
        text.cols += cell.width;
        continue;
      }
      flushText();
      text = { x: cell.col * CELL_W, chars: cell.ch, cols: cell.width, style: cell.style, key: key(cell.style), ascii };
      if (!ascii) flushText();
    }
    flushText();
  });
  return rects.join("") + texts.join("");
}

function frameSize(columns, rows) {
  return { width: columns * CELL_W + PAD * 2, height: rows * CELL_H + PAD * 2 + TITLE_H };
}

function windowChrome(width, height, title) {
  return [
    `<rect width="${width}" height="${height}" rx="10" fill="${THEME.background}"/>`,
    `<rect width="${width}" height="${TITLE_H}" rx="10" fill="#22252c"/>`,
    `<rect y="${TITLE_H - 10}" width="${width}" height="10" fill="#22252c"/>`,
    `<circle cx="20" cy="16" r="6" fill="#ff5f57"/>`,
    `<circle cx="40" cy="16" r="6" fill="#febc2e"/>`,
    `<circle cx="60" cy="16" r="6" fill="#28c840"/>`,
    `<text x="${width / 2}" y="21" fill="#8b919a" font-size="13" text-anchor="middle">${escapeXml(title)}</text>`,
  ].join("");
}

const svgOpen = (width, height) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
  `font-family="'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="${FONT_SIZE}">`;

/** A still image of one frame. */
export function frameToSvg(lines, { columns, rows, title = "" }) {
  const { width, height } = frameSize(columns, rows);
  return (
    svgOpen(width, height) +
    windowChrome(width, height, title) +
    `<g transform="translate(${PAD} ${PAD + TITLE_H})">${renderFrame(lines)}</g></svg>\n`
  );
}

/**
 * A looping animation: each frame is shown for its duration (ms). Frames are
 * stacked and switched with CSS keyframes, which GitHub renders in <img>.
 */
export function framesToSvg(frames, { columns, rows, title = "" }) {
  const { width, height } = frameSize(columns, rows);
  const total = frames.reduce((sum, f) => sum + f.duration, 0);
  const pct = (ms) => ((ms / total) * 100).toFixed(3);
  let start = 0;
  const styles = [];
  const groups = [];
  frames.forEach((frame, i) => {
    const end = start + frame.duration;
    styles.push(
      `@keyframes f${i}{0%{visibility:hidden}${start === 0 ? "" : `${pct(start)}%{visibility:hidden}`}` +
        `${pct(start)}%{visibility:visible}${pct(end)}%{visibility:hidden}100%{visibility:hidden}}` +
        `.f${i}{visibility:hidden;animation:f${i} ${total}ms steps(1,end) infinite}`,
    );
    // The first frame is visible without animation support, e.g. in a still preview.
    const fallback = i === 0 ? ` style="visibility:visible"` : "";
    groups.push(`<g class="f${i}"${fallback}>${renderFrame(frame.lines)}</g>`);
    start = end;
  });
  return (
    svgOpen(width, height) +
    `<style>${styles.join("")}</style>` +
    windowChrome(width, height, title) +
    `<g transform="translate(${PAD} ${PAD + TITLE_H})">${groups.join("")}</g></svg>\n`
  );
}
