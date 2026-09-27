import { Box, Text } from "ink";
import sliceAnsi from "slice-ansi";
import { MoreRow, Spinner } from "./layout.js";

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
  /** Sticky line below the scrolling area, e.g. a "jump to bottom" hint. */
  footer?: string;
  /**
   * Characters replaced by a spinning `Spinner` while their line is visible
   * ("Claude is working…", running agents); the lines themselves stay static.
   * `col` counts columns of the line without its ANSI codes.
   */
  spinner?: { at: { line: number; col: number }[]; active: boolean };
}

/** Height left for the scrolling lines between `header` and an optional footer line. */
export function bodyHeightBelow(header: string[], height: number, footer = false): number {
  return Math.max(1, height - header.length - (footer ? 1 : 0));
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
 * the first or last row becomes a "more" indicator when lines are hidden that
 * way; the bottom one is left out when a footer already sits there.
 */
export function previewWindow(count: number, scroll: number, height: number, footer = false): PreviewWindow {
  const end = Math.min(count, scroll + height);
  // With fewer than three rows there is no room for indicators around the content.
  const top = scroll > 0 && height >= 3;
  const bottom = !footer && end < count && height >= 3;
  const from = scroll + (top ? 1 : 0);
  const to = end - (bottom ? 1 : 0);
  return { from, to, above: top ? from : 0, below: bottom ? count - to : 0 };
}

/** The part of `line` visible after scrolling `hscroll` columns, keeping `frozen` columns fixed. */
export function shiftLine(line: string, hscroll: number, frozen: number, width: number): string {
  if (hscroll <= 0) return line;
  return sliceAnsi(line, 0, frozen) + sliceAnsi(line, frozen + hscroll, hscroll + width);
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
  footer,
  spinner,
}: Props) {
  const bodyHeight = bodyHeightBelow(header, height, footer !== undefined);
  const { from, to, above, below } = previewWindow(lines.length, scroll, bodyHeight, footer !== undefined);
  const visible = lines.slice(from, to);
  const rows = visible.length + (above > 0 ? 1 : 0) + (below > 0 ? 1 : 0);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {header.map((line, i) => (
        <Text key={`h${i}`} wrap="truncate">
          {line || " "}
        </Text>
      ))}
      {above > 0 && <MoreRow arrow="▲" count={above} jumpKey="ctrl+Home" unit={above === 1 ? "line" : "lines"} />}
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
      {below > 0 && <MoreRow arrow="▼" count={below} jumpKey="ctrl+End" unit={below === 1 ? "line" : "lines"} />}
      {footer !== undefined && (
        <>
          {/* Fill short content so the footer sits at the bottom edge. */}
          {Array.from({ length: Math.max(0, bodyHeight - rows) }, (_, i) => (
            <Text key={`f${i}`}> </Text>
          ))}
          <Text wrap="truncate">{footer}</Text>
        </>
      )}
    </Box>
  );
}
