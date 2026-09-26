import { Box, Text, useWindowSize, type Key } from "ink";
import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { paneSwitchKey, useFocused } from "./focus.js";

export type Mode = "chat" | "git";

export interface Layout {
  columns: number;
  rows: number;
  listWidth: number;
  previewWidth: number;
  bodyHeight: number;
}

export function useLayout(): Layout {
  const { columns, rows } = useWindowSize();
  const listWidth = Math.min(40, Math.max(20, Math.floor(columns * 0.3)));
  return {
    columns,
    rows,
    listWidth,
    // list + border + padding
    previewWidth: Math.max(20, columns - listWidth - 3),
    bodyHeight: Math.max(3, rows - 2),
  };
}

export interface Scroll {
  /** First visible line, clamped to the content. */
  scroll: number;
  max: number;
  set: (n: number) => void;
  by: (delta: number) => void;
  /** "all" or how far down the view reaches, e.g. "42%". */
  position: string;
}

/**
 * Scroll helpers over a position kept elsewhere (`raw` may exceed the content,
 * e.g. after it shrank; it is clamped when read).
 */
export function makeScroll(
  raw: number,
  setRaw: Dispatch<SetStateAction<number>>,
  lineCount: number,
  height: number,
): Scroll {
  const max = Math.max(0, lineCount - height);
  const clamp = (n: number) => Math.max(0, Math.min(max, n));
  const clamped = Math.min(raw, max);
  return {
    scroll: clamped,
    max,
    set: (n) => setRaw(clamp(n)),
    // Functional update so several keys in one input chunk all count.
    by: (delta) => setRaw((s) => clamp(Math.min(s, max) + delta)),
    position: lineCount > height ? `${Math.round(((clamped + height) / lineCount) * 100)}%` : "all",
  };
}

/** Vertical scroll position within `lineCount` lines shown `height` at a time. */
export function useScroll(lineCount: number, height: number): Scroll {
  const [scroll, setScroll] = useState(0);
  return makeScroll(scroll, setScroll, lineCount, height);
}

/**
 * Navigation shared by both views: ←→ switch item, ↑↓ scroll the preview.
 * Returns true when the key was handled.
 */
export function handleNavigation(
  input: string,
  key: Key,
  nav: { select: (delta: number) => void; first: () => void; last: () => void; scroll: Scroll; page: number },
): boolean {
  const { select, scroll, page } = nav;
  if (key.leftArrow) select(-1);
  else if (key.rightArrow) select(1);
  else if (key.upArrow) scroll.by(-1);
  else if (key.downArrow) scroll.by(1);
  else if (key.pageUp || input === "b") scroll.by(-page);
  else if (key.pageDown || input === " ") scroll.by(page);
  else if (key.home) scroll.set(0);
  else if (key.end) scroll.set(scroll.max);
  else if (input === "g") nav.first();
  else if (input === "G") nav.last();
  else return false;
  return true;
}

/** The part of `text` between columns `start` and `start + width`. */
export function sliceColumns(text: string, start: number, width: number): string {
  let col = 0;
  let out = "";
  for (const ch of text) {
    const w = stringWidth(ch);
    if (col >= start && col + w <= start + width) out += ch;
    col += w;
  }
  return out;
}

const MARQUEE_STEP_MS = 100;
/** Ticks to rest at either end before moving on. */
const MARQUEE_PAUSE = 12;

/**
 * Text that fits `width` columns, scrolling back and forth when it is longer.
 * Owns its timer so only this element re-renders while it moves.
 */
export function Marquee({ text, width, active }: { text: string; width: number; active: boolean }) {
  const overflow = Math.max(0, stringWidth(text) - width);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setTick(0);
    if (!active || overflow === 0) return;
    const timer = setInterval(() => setTick((n) => n + 1), MARQUEE_STEP_MS);
    return () => clearInterval(timer);
  }, [text, width, active, overflow]);

  if (overflow === 0) return <>{text}</>;
  // Pause, scroll to the end, pause, jump back to the start.
  const pos = tick % (overflow + 2 * MARQUEE_PAUSE);
  const offset = Math.min(overflow, Math.max(0, pos - MARQUEE_PAUSE));
  return <>{sliceColumns(text, offset, width)}</>;
}

export const dim = (s: string) => `\u001b[2m${s}\u001b[22m`;
export const bold = (s: string) => `\u001b[1m${s}\u001b[22m`;

/**
 * Heading shown at the top of the preview: `text` wrapped after a two-column
 * marker, optional dim detail lines, then a separator rule.
 */
export function previewHeader(
  text: string,
  width: number,
  opts: {
    marker: string;
    style: (s: string) => string;
    details?: string[];
    wrap?: (text: string, width: number) => string[];
  },
): string[] {
  const wrap = opts.wrap ?? ((t: string, w: number) => wrapAnsi(t, w, { hard: true }).split("\n"));
  const wrapped = wrap(text, width - 2);
  return [
    ...wrapped.map((l, i) => (i === 0 ? opts.marker : "  ") + opts.style(l)),
    ...(opts.details ?? []).map((d) => "  " + dim(d)),
    dim("─".repeat(width)),
  ];
}

/** Dim horizontal rule, optionally with a label such as a key hint. */
export function rule(width: number, label?: string): string {
  if (!label) return dim("─".repeat(width));
  const text = `── ${label} `;
  return dim(text + "─".repeat(Math.max(0, width - stringWidth(text))));
}

/** Wraps a file path after "/" separators, splitting a segment only when it alone is too wide. */
export function wrapPath(path: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const segment of path.split(/(?<=\/)/)) {
    if (line && stringWidth(line + segment) > width) {
      lines.push(line);
      line = "";
    }
    line += segment;
    while (stringWidth(line) > width) {
      const head = sliceColumns(line, 0, width);
      lines.push(head);
      line = line.slice(head.length);
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function truncate(text: string, width: number): string {
  const line = text.split("\n")[0].replace(/\s+/g, " ").trim();
  if (stringWidth(line) <= width) return line;
  let out = "";
  for (const ch of line) {
    if (stringWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return out + "…";
}

/** Background of the top bar while the viewer has the focus (same blue as the jump hint). */
const FOCUS_BAR = "#264f78";
/** Background of the list selection while the focus is elsewhere, like an inactive editor list. */
const INACTIVE_SELECTION = "#3a3d41";

function Tabs({ mode, focused }: { mode: Mode; focused: boolean }) {
  const tab = (key: string, label: string, m: Mode) =>
    m === mode ? (
      <Text inverse bold>{` ${key} ${label} `}</Text>
    ) : (
      <Text dimColor>{` ${key} ${label} `}</Text>
    );
  return (
    <Text>
      {/* Cyan is hard to read on the blue focus bar. */}
      <Text bold color={focused ? "whiteBright" : "cyan"}>
        cco{" "}
      </Text>
      {tab("1", "Chat", "chat")}
      {tab("2", "Changes", "git")}
    </Text>
  );
}

interface ScreenProps {
  layout: Layout;
  mode: Mode;
  status: ReactNode;
  list: ReactNode;
  preview: ReactNode;
  /** Key help: a plain message, or items of which switched-on options are highlighted. */
  footer: string | FooterItem[];
}

export interface FooterItem {
  /** Key and action, e.g. "f follow". */
  text: string;
  /** The option is currently on or open; shown highlighted. */
  on?: boolean;
}

function Footer({ items }: { items: string | FooterItem[] }) {
  if (typeof items === "string") return <Text dimColor>{items}</Text>;
  return (
    <>
      {items.map((item, i) => (
        <Text key={item.text}>
          {i > 0 && <Text dimColor> · </Text>}
          {item.on ? (
            <Text inverse bold>
              {` ${item.text} `}
            </Text>
          ) : (
            <Text dimColor>{item.text}</Text>
          )}
        </Text>
      ))}
    </>
  );
}

/**
 * Common frame: tab/status bar, list | preview body, key help footer.
 * The top bar shows whether the viewer or Claude Code has the focus; the
 * footer then names the key that switches panes.
 */
export function Screen({ layout, mode, status, list, preview, footer }: ScreenProps) {
  const focused = useFocused();
  const help = focused
    ? typeof footer === "string"
      ? footer
      : // First, because a narrow pane cuts the end of the line off.
        [{ text: `${paneSwitchKey("left")} Claude` }, ...footer]
    : `${paneSwitchKey("right")} focus cco`;
  return (
    <Box flexDirection="column" width={layout.columns} height={layout.rows}>
      <Box width={layout.columns} backgroundColor={focused ? FOCUS_BAR : undefined}>
        <Text wrap="truncate" dimColor={!focused}>
          <Tabs mode={mode} focused={focused} />
          <Text> </Text>
          {status}
        </Text>
      </Box>
      <Box height={layout.bodyHeight}>
        <Box flexDirection="column" width={layout.listWidth} height={layout.bodyHeight}>
          {list}
        </Box>
        <Box
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderDimColor
          paddingLeft={1}
          height={layout.bodyHeight}
        >
          {preview}
        </Box>
      </Box>
      <Text wrap="truncate">
        <Footer items={help} />
      </Text>
    </Box>
  );
}

interface ListProps<T> {
  items: T[];
  selected: number;
  height: number;
  empty: string;
  itemKey: (item: T, index: number) => string;
  render: (item: T, selected: boolean) => ReactNode;
}

/** Selectable list that keeps the selection roughly centred. */
export function List<T>({ items, selected, height, empty, itemKey, render }: ListProps<T>) {
  const focused = useFocused();
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  if (items.length === 0) return <Text dimColor>{empty}</Text>;
  return (
    <>
      {items.slice(start, start + height).map((item, i) => {
        const index = start + i;
        const isSelected = index === selected;
        // Without focus the selection stays visible but quiet.
        return (
          <Text
            key={itemKey(item, index)}
            wrap="truncate"
            inverse={isSelected && focused}
            bold={isSelected && focused}
            backgroundColor={isSelected && !focused ? INACTIVE_SELECTION : undefined}
          >
            {render(item, isSelected)}
          </Text>
        );
      })}
    </>
  );
}
