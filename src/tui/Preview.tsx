import { Box, Text } from "ink";
import sliceAnsi from "slice-ansi";
import { useContext } from "react";
import { openInDefaultApp } from "../open.js";
import { AreaContext, inArea, Spinner } from "./layout.js";
import { linkAt } from "./links.js";
import { useMouse } from "./mouse.js";

/** Lines scrolled per wheel step. */
const WHEEL_LINES = 3;

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
  /** A link was clicked and opened. */
  onLink?: (url: string) => void;
}

/** Height left for the scrolling lines below `header`. */
export function bodyHeightBelow(header: string[], height: number): number {
  return Math.max(1, height - header.length);
}

/**
 * Keeps a sticky header from crowding out the content: at most half the
 * height, always ending with its separator rule.
 */
export function fitHeader(header: string[], height: number): string[] {
  const max = Math.max(2, Math.floor(height / 2));
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
}: Props) {
  const bodyHeight = bodyHeightBelow(header, height);
  const { from, to, above, below } = previewWindow(lines.length, scroll, bodyHeight);
  const thumb = scrollThumb(lines.length, scroll, bodyHeight);
  const area = useContext(AreaContext);
  const jump = (target: "top" | "end") =>
    onJump ? onJump(target) : onWheel?.(target === "top" ? -scroll : lines.length - bodyHeight - scroll);
  // A click on a web address opens it, one on the scroll bar or a badge jumps there; the wheel scrolls.
  useMouse((e) => {
    // The scroll bar sits in the column right of the area.
    const at = inArea({ ...area, width: area.width + (thumb ? 1 : 0) }, e.x, e.y);
    if (!at) return;
    if (e.kind === "wheel") return onWheel?.(e.delta * WHEEL_LINES);
    const bodyRow = at.row - header.length;
    if (thumb && at.col >= width) {
      if (bodyRow >= 0 && bodyRow < bodyHeight) onWheel?.(scrollAtRow(bodyRow, lines.length, bodyHeight) - scroll);
      return;
    }
    if (above > 0 && bodyRow === 0) return jump("top");
    if (below > 0 && bodyRow === bodyHeight - 1) return jump("end");
    let url: string | undefined;
    if (at.row < header.length) url = linkAt(header, at.row, at.col, width);
    else {
      const index = from + at.row - header.length - (above > 0 ? 1 : 0);
      if (index < from || index >= to) return;
      const shifted = pinned.includes(index) || at.col < frozen ? at.col : at.col + hscroll;
      url = linkAt(lines, index, shifted, width);
    }
    if (!url) return;
    openInDefaultApp(url);
    onLink?.(url);
  });
  const visible = lines.slice(from, to);
  const body = (
    <>
      {above > 0 && <Text wrap="truncate">{moreBadge("top", above, width)}</Text>}
      {visible.map((line, i) => {
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
      })}
      {below > 0 && <Text wrap="truncate">{moreBadge("end", below, width)}</Text>}
    </>
  );
  return (
    // The scroll bar takes the column right of the preview, which the layout leaves free.
    <Box flexDirection="column" width={width + (thumb ? 1 : 0)} height={height} overflow="hidden">
      {header.map((line, i) => (
        <Text key={`h${i}`} wrap="truncate">
          {line || " "}
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
