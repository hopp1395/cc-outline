import { Box, Text } from "ink";
import sliceAnsi from "slice-ansi";

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
}: Props) {
  const bodyHeight = bodyHeightBelow(header, height, footer !== undefined);
  const visible = lines.slice(scroll, scroll + bodyHeight);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {header.map((line, i) => (
        <Text key={`h${i}`} wrap="truncate">
          {line || " "}
        </Text>
      ))}
      {visible.map((line, i) => (
        // Lines are pre-wrapped (or shifted) to `width`; a lone space keeps empty lines from collapsing.
        <Text key={scroll + i} wrap="truncate">
          {(pinned.includes(scroll + i) ? line : shiftLine(line, hscroll, frozen, width)) || " "}
        </Text>
      ))}
      {footer !== undefined && (
        <>
          {/* Fill short content so the footer sits at the bottom edge. */}
          {Array.from({ length: Math.max(0, bodyHeight - visible.length) }, (_, i) => (
            <Text key={`f${i}`}> </Text>
          ))}
          <Text wrap="truncate">{footer}</Text>
        </>
      )}
    </Box>
  );
}
