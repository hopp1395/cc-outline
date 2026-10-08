import { Box, Text } from "ink";
import sliceAnsi from "slice-ansi";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { openInDefaultApp } from "../open.js";
import { AreaContext, inArea, Spinner } from "./layout.js";
import { linkAt, shotAt, stripAnsi } from "./links.js";
import { MouseContext, useMouse } from "./mouse.js";
import { highlightColumns, type Point, type Selection, selectedColumns, selectedText } from "./selection.js";
import { useClipboard } from "./useClipboard.js";

/** Lines scrolled per wheel step. */
const WHEEL_LINES = 3;
/** How long the "copied" badge stays. */
export const COPIED_MS = 1500;
/** Columns `previewHeader` puts before each line: the marker, then the wrapped lines' indentation. */
const HEADER_INDENT = 2;

/**
 * Where Ctrl+C copies the selection again: the shown preview that has one puts
 * its copy here (`App` provides it, and calls it on Ctrl+C); false: nothing to copy.
 */
export const CopySelectionContext = createContext<{ current?: () => boolean }>({});

/** Where a selection is: in the sticky header or in the scrolling lines. */
type Region = "header" | "body";

/** Whether `line` is a plain rule, like the one that closes a header. */
const isRule = (line: string) => /^─+$/.test(stripAnsi(line));

interface Props {
  /** Sticky lines above the scrolling area, e.g. the prompt or file name. */
  header?: string[];
  lines: string[];
  scroll: number;
  width: number;
  height: number;
  /** Columns scrolled sideways (for unwrapped lines). */
  hscroll?: number;
  /** Leading columns that stay in place when scrolling sideways, e.g. line numbers. */
  frozen?: number;
  /** Indices of lines that never scroll sideways, e.g. hunk headers. */
  pinned?: number[];
  /**
   * Characters replaced by a spinning `Spinner` while their line is visible
   * ("Claude is working…", running agents); the lines themselves stay static.
   * `col` counts columns of the line without its ANSI codes.
   */
  spinner?: { at: { line: number; col: number }[]; active: boolean };
  /** Mouse wheel over the preview: lines to scroll (negative is up). */
  onWheel?: (delta: number) => void;
  /** A click on the top or bottom badge; without it, the preview scrolls there through `onWheel`. */
  onJump?: (to: "top" | "end") => void;
  /** A link was clicked and opened; links open on release, so a drag that starts on one selects instead. */
  onLink?: (url: string) => void;
  /** A click on a screenshot mark `[▣ n]` in the body; on release, like links. */
  onShot?: (n: number) => void;
}

/** Height left for the scrolling lines below `header`. */
export function bodyHeightBelow(header: string[], height: number): number {
  return Math.max(1, height - header.length);
}

/** Rows a sticky header may take of `height`, its rule included: half, at least two. */
export function headerRows(height: number): number {
  return Math.max(2, Math.floor(height / 2));
}

/**
 * Keeps a sticky header from crowding out the content: at most half the
 * height, always ending with its separator rule.
 */
export function fitHeader(header: string[], height: number): string[] {
  const max = headerRows(height);
  if (header.length <= max) return header;
  return [...header.slice(0, max - 1), header.at(-1)!];
}

export interface PreviewWindow {
  /** Lines shown: indices from..to (exclusive). */
  from: number;
  to: number;
  /** Hidden lines counted by the "more" rows above and below; 0 when there is no such row. */
  above: number;
  below: number;
}

/**
 * Which of `count` lines are shown at `scroll` in `height` rows. Like the list,
 * the first or last row becomes a "more" badge when lines are hidden that way.
 */
export function previewWindow(count: number, scroll: number, height: number): PreviewWindow {
  const end = Math.min(count, scroll + height);
  // With fewer than three rows there is no room for badges around the content.
  const top = scroll > 0 && height >= 3;
  const bottom = end < count && height >= 3;
  const from = scroll + (top ? 1 : 0);
  const to = end - (bottom ? 1 : 0);
  return { from, to, above: top ? from : 0, below: bottom ? count - to : 0 };
}

export interface Thumb {
  /** First row of the thumb and its length, in rows of the track. */
  start: number;
  size: number;
}

/**
 * The scroll bar's thumb for `count` lines shown `rows` at a time from
 * `scroll`, or none when everything fits. Its size is the share shown; it
 * touches the top or bottom of the track only at the very top or end, so
 * both are told apart from "nearly there" at a glance.
 */
export function scrollThumb(count: number, scroll: number, rows: number): Thumb | undefined {
  if (count <= rows || rows < 3) return undefined;
  const max = count - rows;
  const size = Math.max(1, Math.min(rows - 2, Math.round((rows * rows) / count)));
  const room = rows - size;
  if (scroll <= 0) return { start: 0, size };
  if (scroll >= max) return { start: room, size };
  const start = Math.round((room * scroll) / max);
  return { start: Math.max(1, Math.min(room - 1, start)), size };
}

/** The scroll position a click on row `row` of the track jumps to. */
export function scrollAtRow(row: number, count: number, rows: number): number {
  const max = Math.max(0, count - rows);
  return Math.round((Math.max(0, Math.min(rows - 1, row)) / Math.max(1, rows - 1)) * max);
}

const BADGE_ON = "\u001b[48;2;38;79;120m\u001b[97m";
const BADGE_OFF = "\u001b[39m\u001b[49m";

/**
 * The badge on the first or last row when lines are hidden that way,
 * "↓ 15 more lines (ctrl+End)", centred in `width` with a blue background.
 * In narrow previews the key goes first, then the unit.
 */
export function moreBadge(to: "top" | "end", count: number, width: number): string {
  const arrow = to === "top" ? "↑" : "↓";
  const key = to === "top" ? "ctrl+Home" : "ctrl+End";
  const more = `${arrow} ${count} more`;
  const unit = `${more} ${count === 1 ? "line" : "lines"}`;
  const label = [`${unit} (${key})`, unit].find((l) => l.length + 2 <= width) ?? more;
  return centredBadge(label, width);
}

/** `label` as a blue badge centred in `width` columns, like the "more lines" rows. */
export function centredBadge(label: string, width: number): string {
  const text = ` ${label} `;
  const indent = Math.max(0, Math.floor((width - text.length) / 2));
  return " ".repeat(indent) + BADGE_ON + text + BADGE_OFF;
}

/** The part of `line` visible after scrolling `hscroll` columns, keeping `frozen` columns fixed. */
export function shiftLine(line: string, hscroll: number, frozen: number, width: number): string {
  if (hscroll <= 0) return line;
  return sliceAnsi(line, 0, frozen) + sliceAnsi(line, frozen + hscroll, hscroll + width);
}

/**
 * A one column track (dim `│`) with the thumb showing which part of the lines
 * is in view. The thumb is a coloured space, not `┃` or `█`: fonts draw those
 * shorter than the cell, which leaves gaps between the rows.
 */
function ScrollBar({ thumb, rows }: { thumb: Thumb; rows: number }) {
  return (
    <Box flexDirection="column" width={1} height={rows}>
      {Array.from({ length: rows }, (_, i) =>
        i >= thumb.start && i < thumb.start + thumb.size ? (
          <Text key={i} backgroundColor="gray">
            {" "}
          </Text>
        ) : (
          <Text key={i} dimColor>
            │
          </Text>
        ),
      )}
    </Box>
  );
}

export function Preview({
  header = [],
  lines,
  scroll,
  width,
  height,
  hscroll = 0,
  frozen = 0,
  pinned = [],
  spinner,
  onWheel,
  onJump,
  onLink,
  onShot,
}: Props) {
  const bodyHeight = bodyHeightBelow(header, height);
  const { from, to, above, below } = previewWindow(lines.length, scroll, bodyHeight);
  const thumb = scrollThumb(lines.length, scroll, bodyHeight);
  const area = useContext(AreaContext);
  const jump = (target: "top" | "end") =>
    onJump ? onJump(target) : onWheel?.(target === "top" ? -scroll : lines.length - bodyHeight - scroll);
  const copy = useClipboard();
  // The header (the prompt, a path) selects apart from the scrolling lines, without its closing rule.
  const headerLines = header.length - (header.length > 0 && isRule(header.at(-1)!) ? 1 : 0);
  const source = (region: Region) => (region === "header" ? header : lines);
  // The selection counts only while the line it started in is unchanged: other lines (another entry, a new width) drop it.
  const [selection, setSelection] = useState<Selection & { region: Region; check: string }>();
  const selected = selection && source(selection.region)[selection.anchor.line] === selection.check ? selection : undefined;
  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  // The press the left button is held since: where a drag selects from, and the link it opens if it is let go without one.
  const press = useRef<{ region: Region; at?: Point; url?: string; shot?: number; dragged: boolean }>(undefined);
  /** The cell of the lines under body row `bodyRow` and column `col`, kept within the lines shown. */
  const pointAt = (bodyRow: number, col: number): Point => {
    const index = Math.max(from, Math.min(to - 1, from + bodyRow - (above > 0 ? 1 : 0)));
    const c = Math.max(0, Math.min(width - 1, col));
    return { line: index, col: pinned.includes(index) || c < frozen ? c : c + hscroll };
  };
  /** The same for the header, which does not scroll. */
  const headerPointAt = (row: number, col: number): Point => ({
    line: Math.max(0, Math.min(headerLines - 1, row)),
    col: Math.max(0, Math.min(width - 1, col)),
  });
  /**
   * Columns every line of a selection starting at `at` leaves out: the gutter
   * (line numbers) when it starts right of it; in the header the marker and
   * the indentation of its wrapped lines (`previewHeader`).
   */
  const gutterFor = (region: Region, at: Point) => {
    if (region === "body") return frozen > 0 && at.col >= frozen ? frozen : 0;
    const indented = header.slice(1, headerLines).every((l) => stripAnsi(l).startsWith(" ".repeat(HEADER_INDENT)));
    return indented && at.col >= HEADER_INDENT ? HEADER_INDENT : 0;
  };
  /** Copies the selection, if there is one with text; false otherwise. */
  const copySelection = () => {
    if (!selected) return false;
    const text = selectedText(source(selected.region), selected);
    if (!text) return false;
    const count = text.split("\n").length;
    copy(text).then(
      () => setCopied(`copied ${count === 1 ? "1 line" : `${count} lines`}`),
      () => setCopied("copy failed"),
    );
    return true;
  };
  // Ctrl+C copies it again while this preview is shown (its mouse context is on).
  const copyKey = useContext(CopySelectionContext);
  const shown = useContext(MouseContext);
  useEffect(() => {
    if (!shown || !selected) return;
    copyKey.current = copySelection;
    return () => {
      if (copyKey.current === copySelection) copyKey.current = undefined;
    };
  });
  // A click on a web address opens it, one on the scroll bar or a badge jumps there; the wheel scrolls; a drag selects text and copies it.
  useMouse((e) => {
    // The right button drops the selection, wherever it is pressed.
    if (e.kind === "right") {
      press.current = undefined;
      return setSelection(undefined);
    }
    if (e.kind === "drag" || e.kind === "release") {
      const held = press.current;
      if (!held) return;
      if (e.kind === "release") {
        press.current = undefined;
        if (held.dragged) copySelection();
        else if (!held.dragged && held.url) {
          openInDefaultApp(held.url);
          onLink?.(held.url);
        } else if (!held.dragged && held.shot !== undefined) onShot?.(held.shot);
        return;
      }
      // A drag from where there is nothing to select (the header's rule) no longer opens a link either.
      if (!held.at) {
        held.dragged = true;
        return;
      }
      let focus: Point;
      if (held.region === "header") focus = headerPointAt(e.y - area.y, e.x - area.x);
      else {
        const bodyRow = e.y - area.y - header.length;
        // Dragging past the top or bottom scrolls on, a line per move.
        if (bodyRow < (above > 0 ? 1 : 0) && from > 0) onWheel?.(-1);
        else if (bodyRow > bodyHeight - 1 - (below > 0 ? 1 : 0) && to < lines.length) onWheel?.(1);
        focus = pointAt(bodyRow, e.x - area.x);
      }
      if (!held.dragged && focus.line === held.at.line && focus.col === held.at.col) return;
      held.dragged = true;
      const { region, at } = held;
      setSelection({ anchor: at, focus, from: gutterFor(region, at), region, check: source(region)[at.line] });
      return;
    }
    // The scroll bar sits in the column right of the area.
    const at = inArea({ ...area, width: area.width + (thumb ? 1 : 0) }, e.x, e.y);
    if (!at) return;
    if (e.kind === "wheel") return onWheel?.(e.delta * WHEEL_LINES);
    setSelection(undefined);
    press.current = undefined;
    const bodyRow = at.row - header.length;
    if (thumb && at.col >= width) {
      if (bodyRow >= 0 && bodyRow < bodyHeight) onWheel?.(scrollAtRow(bodyRow, lines.length, bodyHeight) - scroll);
      return;
    }
    if (above > 0 && bodyRow === 0) return jump("top");
    if (below > 0 && bodyRow === bodyHeight - 1) return jump("end");
    if (at.row < header.length) {
      const url = linkAt(header, at.row, at.col, width);
      press.current = { region: "header", at: at.row < headerLines ? headerPointAt(at.row, at.col) : undefined, url, dragged: false };
      return;
    }
    const index = from + bodyRow - (above > 0 ? 1 : 0);
    if (index < from || index >= to) return;
    const point = pointAt(bodyRow, at.col);
    press.current = { region: "body", at: point, url: linkAt(lines, index, point.col, width), shot: onShot ? shotAt(lines[index], point.col) : undefined, dragged: false };
  });
  const marked = (line: string, index: number, region: Region) => {
    const cols = selected?.region === region && selectedColumns(selected, index);
    return cols ? highlightColumns(line, cols[0], cols[1]) : line;
  };
  const rows: ReactNode[] = lines.slice(from, to).map((raw, i) => {
    const line = marked(raw, from + i, "body");
    const spin = spinner?.at.find((s) => s.line === from + i);
    return spin ? (
      <Text key={from + i} wrap="truncate">
        {sliceAnsi(line, 0, spin.col)}
        <Spinner active={spinner!.active} />
        {sliceAnsi(line, spin.col + 1)}
      </Text>
    ) : (
      // Lines are pre-wrapped (or shifted) to `width`; a lone space keeps empty lines from collapsing.
      <Text key={from + i} wrap="truncate">
        {(pinned.includes(from + i) ? line : shiftLine(line, hscroll, frozen, width)) || " "}
      </Text>
    );
  });
  if (above > 0) rows.unshift(<Text key="above" wrap="truncate">{moreBadge("top", above, width)}</Text>);
  if (below > 0) rows.push(<Text key="below" wrap="truncate">{moreBadge("end", below, width)}</Text>);
  // "copied" takes the bottom row for a moment, over the badge or the last line.
  if (copied) rows.splice(Math.min(rows.length, bodyHeight - 1), 1, <Text key="copied" wrap="truncate">{centredBadge(copied, width)}</Text>);
  const body = <>{rows}</>;
  return (
    // The scroll bar takes the column right of the preview, which the layout leaves free.
    <Box flexDirection="column" width={width + (thumb ? 1 : 0)} height={height} overflow="hidden">
      {header.map((line, i) => (
        <Text key={`h${i}`} wrap="truncate">
          {marked(line, i, "header") || " "}
        </Text>
      ))}
      {thumb ? (
        <Box height={bodyHeight}>
          <Box flexDirection="column" width={width} height={bodyHeight} overflow="hidden">
            {body}
          </Box>
          <ScrollBar thumb={thumb} rows={bodyHeight} />
        </Box>
      ) : (
        body
      )}
    </Box>
  );
}
