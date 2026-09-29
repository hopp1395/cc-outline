import { Box, Text, measureElement, useWindowSize, type DOMElement, type Key } from "ink";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { paneSwitchKey, useFocused } from "./focus.js";
import { isViewShown, type ListOrder } from "../settings.js";
import { useSetting, useSettings } from "./useSetting.js";
import { useMouse } from "./mouse.js";
import { useReload } from "./reload.js";
import { useUpdateInfo } from "./useUpdate.js";
import { VERSION } from "../version.js";
import { entryGroups, periodLabel, periodOf, ruleText, separatorsAt, type Period } from "./days.js";

export type Mode = "chat" | "git" | "plan" | "sessions" | "settings" | "monitor";

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
  /** Where the view is: "all", "top", "end", or the lines shown in between, e.g. "121–160/300". */
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
    position: scrollPosition(clamped, max, lineCount, height),
  };
}

/** The status text for a view at `scroll` (see `Scroll.position`). */
export function scrollPosition(scroll: number, max: number, lineCount: number, height: number): string {
  if (lineCount <= height) return "all";
  if (scroll <= 0) return "top";
  if (scroll >= max) return "end";
  return `${scroll + 1}–${scroll + height}/${lineCount}`;
}

/** Vertical scroll position within `lineCount` lines shown `height` at a time. */
export function useScroll(lineCount: number, height: number): Scroll {
  const [scroll, setScroll] = useState(0);
  return makeScroll(scroll, setScroll, lineCount, height);
}

/**
 * Navigation shared by all views: ↑↓ switch item, PgUp/PgDn scroll the
 * preview by page and Ctrl+↑↓ by line, Home/End first/last item, Ctrl+Home/End
 * top/bottom of the preview. Shift+↑↓ (marks, see markKeys) is swallowed here,
 * so lists without marks do not take it for a plain ↑↓. Plain ←→ do nothing.
 * Returns true when the key was handled.
 */
export function handleNavigation(
  input: string,
  key: Key,
  nav: { select: (delta: number) => void; first: () => void; last: () => void; scroll: Scroll; page: number },
): boolean {
  const { select, scroll, page } = nav;
  if (key.upArrow || key.downArrow) {
    const dir = key.upArrow ? -1 : 1;
    if (key.ctrl) scroll.by(dir);
    else if (!key.shift) select(dir);
  } else if (key.pageUp) scroll.by(-page);
  else if (key.pageDown) scroll.by(page);
  else if (key.home) (key.ctrl ? scroll.set(0) : nav.first());
  else if (key.end) (key.ctrl ? scroll.set(scroll.max) : nav.last());
  else if (input === "g") nav.first();
  else if (input === "G") nav.last();
  else return false;
  return true;
}

/**
 * Marks (favourites) work the same in every list: Space marks or unmarks the
 * selected entry, Shift+↑/↓ jump to the previous / next marked one.
 */
export function markKeys(input: string, key: Key): "toggle" | 1 | -1 | undefined {
  if (input === " ") return "toggle";
  if (key.shift && !key.ctrl && key.upArrow) return -1;
  if (key.shift && !key.ctrl && key.downArrow) return 1;
  return undefined;
}

/** Help-line items for marks: highlighted while the selected entry is marked. */
export function markFooter(currentMarked: boolean, markedCount: number): FooterItem[] {
  return [
    { text: "␣ mark", on: currentMarked },
    ...(markedCount > 0 ? [{ text: "⇧↑↓ marked", priority: 2 }] : []),
  ];
}

/** The ★ that starts a marked entry in a list. */
export function Star() {
  return <Text color="yellow">★ </Text>;
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
/** A marquee moves at most this many columns, then starts over; long prompts would take minutes otherwise. */
export const MARQUEE_MAX_SCROLL = 250;

/**
 * Columns a marquee is shifted at `tick`: rest at the start, move one column
 * per tick up to the end of the text but at most `MARQUEE_MAX_SCROLL`, rest,
 * then start over.
 */
export function marqueeOffset(tick: number, overflow: number): number {
  const distance = Math.min(overflow, MARQUEE_MAX_SCROLL);
  if (distance <= 0) return 0;
  const pos = tick % (distance + 2 * MARQUEE_PAUSE);
  return Math.min(distance, Math.max(0, pos - MARQUEE_PAUSE));
}

/**
 * Text that fits `width` columns on one line, scrolling when it is longer
 * (see `marqueeOffset`). Line breaks and runs of spaces become one space.
 * Owns its timer so only this element re-renders while it moves.
 */
export function Marquee({ text, width, active, lead }: { text: string; width: number; active: boolean; lead?: Lead }) {
  const line = text.replace(/\s+/g, " ").trim();
  const overflow = Math.max(0, stringWidth(line) - width);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setTick(0);
    if (!active || overflow === 0) return;
    const timer = setInterval(() => setTick((n) => n + 1), MARQUEE_STEP_MS);
    return () => clearInterval(timer);
  }, [line, width, active, overflow]);

  if (overflow === 0) return <Led text={line} offset={0} lead={lead} />;
  const offset = marqueeOffset(tick, overflow);
  return <Led text={sliceColumns(line, offset, width)} offset={offset} lead={lead} />;
}

/** The first `columns` of an entry's text in their own colour, e.g. the name of a slash command. */
export interface Lead {
  columns: number;
  color: string;
}

/** `text`, the visible part of an entry from column `offset` on, split into what is left of its lead and the rest. */
export function leadParts(text: string, offset: number, lead?: Lead): [string, string] {
  const n = lead ? Math.max(0, lead.columns - offset) : 0;
  return n === 0 ? ["", text] : [sliceColumns(text, 0, n), sliceColumns(text, n, Infinity)];
}

function Led({ text, offset, lead }: { text: string; offset: number; lead?: Lead }) {
  const [head, rest] = leadParts(text, offset, lead);
  if (!head) return <>{text}</>;
  return (
    <>
      <Text color={lead!.color}>{head}</Text>
      {rest}
    </>
  );
}

const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const SPINNER_STEP_MS = 80;

/** One column that spins while `active`, like Claude Code's own; owns its timer so only it re-renders. */
export function Spinner({ active }: { active: boolean }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((n) => (n + 1) % SPINNER_FRAMES.length), SPINNER_STEP_MS);
    return () => clearInterval(timer);
  }, [active]);
  return <Text color="#d97757">{SPINNER_FRAMES[frame]}</Text>;
}

/**
 * A list entry's text in `width` columns: the selected entry scrolls when it
 * is too long (while the view is `active` and the `marquee` setting is on),
 * the others are cut with "…".
 */
export function EntryText({ text, width, selected, active, lead }: { text: string; width: number; selected: boolean; active: boolean; lead?: Lead }) {
  const [marquee] = useSetting("marquee");
  return selected && marquee ? <Marquee text={text} width={width} active={active} lead={lead} /> : <Led text={truncate(text, width)} offset={0} lead={lead} />;
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

/** Background of the top bar while the viewer has the focus: a dark blue that keeps its text readable. */
const FOCUS_BAR = "#0e2f55";
/**
 * Top bar backgrounds for the session colours of /color, as Claude Code names
 * them: dark enough for white text, and darker still while the focus is
 * elsewhere, so the bar keeps showing the focus.
 */
export const SESSION_BARS: Record<string, { focused: string; unfocused: string }> = {
  red: { focused: "#7a1f1f", unfocused: "#3d1616" },
  orange: { focused: "#7a3f0e", unfocused: "#3d240e" },
  yellow: { focused: "#6b5a0e", unfocused: "#36300f" },
  green: { focused: "#1e5e2c", unfocused: "#15311b" },
  cyan: { focused: "#0e5a60", unfocused: "#0f3134" },
  blue: { focused: "#1c4b8c", unfocused: "#13263f" },
  purple: { focused: "#4f2d80", unfocused: "#2a1b42" },
  pink: { focused: "#7a2a5e", unfocused: "#3f1a33" },
};
/** The colour of the shown session (/color); undefined for none, or one cco does not know. */
export const SessionColorContext = createContext<string | undefined>(undefined);

/** The top bar's background: the session colour's, else the blue focus bar while focused. */
export function barBackground(color: string | undefined, focused: boolean): string | undefined {
  const bar = color ? SESSION_BARS[color] : undefined;
  if (bar) return focused ? bar.focused : bar.unfocused;
  return focused ? FOCUS_BAR : undefined;
}
/** Background of the list selection while the focus is elsewhere, like an inactive editor list. */
const INACTIVE_SELECTION = "#3a3d41";

function Tabs({ mode, focused }: { mode: Mode; focused: boolean }) {
  const settings = useSettings();
  // A hidden view shows its tab only while it is open (opened by a /cco:… command).
  const tab = (key: string, label: string, m: Mode) =>
    m !== mode && !isViewShown(settings, m) ? null : m === mode ? (
      <Text inverse bold>{` ${key} ${label} `}</Text>
    ) : (
      <Text dimColor={!focused}>{` ${key} ${label} `}</Text>
    );
  return (
    <Text>
      {/* Cyan is hard to read on the blue focus bar. */}
      <Text bold color={focused ? "whiteBright" : "cyan"}>
        cco{" "}
      </Text>
      {tab("1", "Chat", "chat")}
      {tab("2", "Changes", "git")}
      {tab("3", "Plan", "plan")}
      {tab("4", "Sessions", "sessions")}
      {tab("5", "Monitor", "monitor")}
      {tab("6", "Settings", "settings")}
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
  /**
   * 1 (dropped first) to 4 (kept longest) when the line is too narrow;
   * default 3. Items that are on are never dropped.
   */
  priority?: number;
}

const SEPARATOR = "  ";
const INFO_ITEM: FooterItem = { text: "i info" };
const MORE_ITEM: FooterItem = { text: "i more" };
const QUIT_ITEM: FooterItem = { text: "q quit" };

const itemWidth = (item: FooterItem) => stringWidth(item.text) + (item.on ? 2 : 0);
const lineWidth = (items: FooterItem[]) =>
  items.reduce((sum, item) => sum + itemWidth(item), 0) + SEPARATOR.length * Math.max(0, items.length - 1);
/**
 * The key help that fits `width` columns. `i` and `q` always stay at the end.
 * When not everything fits, the lowest-priority items (rightmost first) are
 * dropped and `i` points to the full key list in the info dialog. Switched-on
 * options stay, since they also show state; if the line is still too long,
 * the terminal cuts it off.
 */
export function fitFooter(items: FooterItem[], width: number): FooterItem[] {
  const all = [...items, INFO_ITEM, QUIT_ITEM];
  if (lineWidth(all) <= width) return all;
  const tail = [MORE_ITEM, QUIT_ITEM];
  const dropOrder = items
    .map((item, index) => ({ index, item }))
    .filter(({ item }) => !item.on)
    .sort((a, b) => (a.item.priority ?? 3) - (b.item.priority ?? 3) || b.index - a.index);
  const dropped = new Set<number>();
  const kept = () => items.filter((_, i) => !dropped.has(i));
  for (const { index } of dropOrder) {
    if (lineWidth([...kept(), ...tail]) <= width) break;
    dropped.add(index);
  }
  return [...kept(), ...tail];
}

function Footer({ items }: { items: string | FooterItem[] }) {
  if (typeof items === "string") return <Text dimColor>{items}</Text>;
  return (
    <>
      {items.map((item, i) => (
        <Text key={item.text}>
          {i > 0 && <Text>{SEPARATOR}</Text>}
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
const VERSION_LABEL = ` v${VERSION} `;

/** The status while the view reloads (F5), ahead of the view's own. */
function ReloadStatus() {
  const { status } = useReload();
  if (status === "loading")
    return (
      <Text>
        <Spinner active /> reloading… ·{" "}
      </Text>
    );
  return status === "done" ? <Text color="green">reloaded · </Text> : null;
}

/**
 * The label right of the top bar: the version, or the update on offer (` v0.7.0 → 0.8.0 `,
 * ` ↻ 0.8.0 ` once another viewer installed it) with a short form for narrow panes.
 */
export function versionLabels(state: ReturnType<typeof useUpdateInfo>["state"]): { full: string; short?: string } {
  if (state.kind === "update") return { full: ` v${VERSION} → ${state.target} `, short: ` ↑ ${state.target} ` };
  if (state.kind === "restart") return { full: ` ↻ ${state.target} `, short: ` ↻ ${state.target} ` };
  return { full: VERSION_LABEL };
}

export function Screen({ layout, mode, status, list, preview, footer }: ScreenProps) {
  const focused = useFocused();
  const background = barBackground(useContext(SessionColorContext), focused);
  const update = useUpdateInfo();
  const labels = versionLabels(update.state);
  // The version goes right of the tabs and status, only if they leave room for it; an update always shows.
  const barRef = useRef<DOMElement>(null);
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    if (!barRef.current) return;
    const now = measureElement(barRef.current).width + labels.full.length <= layout.columns;
    if (now !== fits) setFits(now);
  });
  const label = fits ? labels.full : labels.short;
  // A click on the update opens it in Settings.
  useMouse((e) => {
    if (e.kind === "click" && e.y === 0 && label && e.x >= layout.columns - label.length) update.open();
  }, labels.short !== undefined);
  const help = focused
    ? typeof footer === "string"
      ? footer
      : fitFooter([{ text: paneSwitchKey("left"), priority: 3 }, ...footer], layout.columns)
    : `${paneSwitchKey("right")} focus cco`;
  return (
    <Box flexDirection="column" width={layout.columns} height={layout.rows}>
      <Box width={layout.columns} backgroundColor={background}>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Box ref={barRef} flexShrink={0}>
            <Text wrap="truncate">
              <Tabs mode={mode} focused={focused} />
              <Text> </Text>
              {update.notice && <Text color="green">{`updated to v${update.notice} · restart Claude Code for the plugin · `}</Text>}
              <ReloadStatus />
              {status}
            </Text>
          </Box>
        </Box>
        {label &&
          (labels.short ? (
            <Text color="yellowBright" bold>
              {label}
            </Text>
          ) : (
            <Text dimColor={!focused}>{label}</Text>
          ))}
      </Box>
      <Box height={layout.bodyHeight}>
        <Box flexDirection="column" width={layout.listWidth} height={layout.bodyHeight}>
          <AreaContext.Provider value={{ x: 0, y: 1, width: layout.listWidth, height: layout.bodyHeight }}>{list}</AreaContext.Provider>
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
          <AreaContext.Provider value={{ x: layout.listWidth + 2, y: 1, width: layout.previewWidth, height: layout.bodyHeight }}>
            {preview}
          </AreaContext.Provider>
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
  /** Mouse: a click selects the entry under it, the wheel the previous or next one. */
  onPick?: (index: number) => void;
  /** A click on an entry, after `onPick` selected it (the wheel only picks). */
  onClick?: (index: number) => void;
  /** Show the items bottom-up (newest first for a chronological list). */
  reversed?: boolean;
  /** The time of an item: a separator starts each day, or with `period` each year (see `entryGroups`). */
  time?: (item: T) => string | number | undefined;
  period?: Period;
  /** The named group of an item (Settings): a separator with its name starts each group, whatever `dateSeparators` says. */
  group?: (item: T) => string;
  /** A filter's entries (natural indexes); the others are left out. `selected` and `onPick` stay natural indexes. */
  shown?: number[];
  /** The filter in effect, shown in the top row: its text and "12 of 340". */
  filter?: { query: string; count: string };
}

/** Where a part of the Screen (list or preview) sits on the terminal, for mapping mouse positions to it. */
export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const AreaContext = createContext<Area>({ x: 0, y: 0, width: 0, height: 0 });

/** The position of a mouse event inside `area`, or undefined when it is outside. */
export function inArea(area: Area, x: number, y: number): { col: number; row: number } | undefined {
  const col = x - area.x;
  const row = y - area.y;
  return col >= 0 && col < area.width && row >= 0 && row < area.height ? { col, row } : undefined;
}

export interface ListWindow {
  /** Items shown as entries: indices from..to (exclusive). */
  from: number;
  to: number;
  /** Items hidden above and below; a row with ▲/▼ takes the place of the first/last entry. */
  above: number;
  below: number;
}

/**
 * Which of `count` items fit in `height` rows with the selection roughly centred.
 * When items are cut off, the first or last row becomes a "more" indicator.
 */
export function listWindow(count: number, selected: number, height: number): ListWindow {
  if (count <= height) return { from: 0, to: count, above: 0, below: 0 };
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), count - height));
  // With fewer than three rows there is no room for indicators around the selection.
  const top = start > 0 && height >= 3;
  const bottom = start + height < count && height >= 3;
  const from = start + (top ? 1 : 0);
  const to = start + height - (bottom ? 1 : 0);
  return { from, to, above: from, below: count - to };
}

/** "▲ 7 more Home": how many entries of a list are hidden and the key that jumps to the far end. */
export function MoreRow({ arrow, count, jumpKey, group }: { arrow: string; count: number; jumpKey: string; group?: string }) {
  return (
    <Text dimColor wrap="truncate">
      {` ${arrow} ${count} more${group ? ` · ${group}` : ""}  `}
      <Text color="yellow">{jumpKey}</Text>
    </Text>
  );
}

/** Selectable list that keeps the selection roughly centred. */
/**
 * A list of entries with one selected. With `reversed`, it shows `items`
 * bottom-up: `selected` and `onPick` stay indexes into `items`, so a view
 * keeps its data in its natural order and only the display is mirrored.
 */
export function List<T>(props: ListProps<T>) {
  const area = useContext(AreaContext);
  if (!props.filter) return <ListBody {...props} />;
  // The filter in effect takes the top row; the entries (and the mouse) start below it.
  const height = Math.max(1, props.height - 1);
  return (
    <>
      <FilterRow filter={props.filter} width={area.width || 40} />
      <AreaContext.Provider value={{ ...area, y: area.y + 1, height }}>
        <ListBody {...props} height={height} />
      </AreaContext.Provider>
    </>
  );
}

/** The top row of a filtered list: the filter text, how many entries match, and the key that drops it. */
function FilterRow({ filter, width }: { filter: { query: string; count: string }; width: number }) {
  return (
    <Text wrap="truncate">
      <Text color="black" backgroundColor="yellow">{" ⌕ "}</Text>
      <Text color="yellow" bold>{` ${truncate(filter.query, Math.max(4, width - filter.count.length - 16))}`}</Text>
      <Text dimColor>
        {` · ${filter.count} · `}
        <Text color="yellow">^F</Text> clear
      </Text>
    </Text>
  );
}

function ListBody<T>(all: ListProps<T>) {
  const [separators] = useSetting("dateSeparators");
  const props = all.shown ? shownOnly(all, all.shown) : all;
  // Days are taken in the natural order, so an item without a time joins the one before it.
  const period = props.period ?? "day";
  const groups = props.group
    ? props.items.map(props.group)
    : separators && props.time
      ? entryGroups(props.items.map((item) => periodOf(props.time!(item), period)), period)
      : undefined;
  if (!props.reversed) return <ListRows {...props} groups={groups} />;
  const last = props.items.length - 1;
  const flip = (i: number) => last - i;
  return (
    <ListRows
      {...props}
      items={[...props.items].reverse()}
      groups={groups && [...groups].reverse()}
      selected={flip(props.selected)}
      itemKey={(item, i) => props.itemKey(item, flip(i))}
      onPick={props.onPick && ((i) => props.onPick!(flip(i)))}
      onClick={props.onClick && ((i) => props.onClick!(flip(i)))}
    />
  );
}

/**
 * The list of the entries a filter shows (`shown`: natural indexes), with
 * `selected`, `onPick` and `itemKey` mapped like for `reversed`, which applies after it.
 */
function shownOnly<T>(props: ListProps<T>, shown: number[]): ListProps<T> {
  return {
    ...props,
    shown: undefined,
    items: shown.map((i) => props.items[i]),
    selected: shown.indexOf(props.selected),
    itemKey: (item, i) => props.itemKey(item, shown[i]),
    onPick: props.onPick && ((i) => props.onPick!(shown[i])),
    onClick: props.onClick && ((i) => props.onClick!(shown[i])),
  };
}

/** A row of a list: an item (by index) or the separator before a group's (day's) first item. */
type ListRow = { item: number } | { group: string; before: number };

/** The rows of `count` items with a separator above each group's items (`groups` in display order). */
export function listRows(count: number, groups: string[] | undefined): ListRow[] {
  const before = separatorsAt(groups);
  const rows: ListRow[] = [];
  for (let i = 0; i < count; i++) {
    const group = before[i];
    if (group) rows.push({ group, before: i });
    rows.push({ item: i });
  }
  return rows;
}

/**
 * Navigation of a list shown `reversed`: ↑/↓ and Home/End follow what is on
 * screen, so a step down the display is a step back in the list's own order.
 */
export function orderedNav<N extends { select: (delta: number) => void; first: () => void; last: () => void }>(reversed: boolean, nav: N): N {
  return reversed ? { ...nav, select: (delta: number) => nav.select(-delta), first: nav.last, last: nav.first } : nav;
}

/** s: the other order of a time-ordered list. */
export const flipOrder = (order: ListOrder): ListOrder => (order === "newest-first" ? "oldest-first" : "newest-first");

/** The help line item of s: the current order, highlighted when it is not the list's default. */
export function orderFooter(order: ListOrder, byDefault: ListOrder): FooterItem {
  return { text: order === "newest-first" ? "s newest first" : "s oldest first", on: order !== byDefault, priority: 3 };
}

/** A direction on screen (Shift+↑/↓ between marks) in the list's own order. */
export const orderedDir = (reversed: boolean, dir: 1 | -1): 1 | -1 => (reversed ? (-dir as 1 | -1) : dir);

function ListRows<T>({ items, selected, height, empty, itemKey, render, onPick, onClick, groups, group }: ListProps<T> & { groups?: string[] }) {
  const focused = useFocused();
  const area = useContext(AreaContext);
  const rows = listRows(items.length, groups);
  const selectedRow = rows.findIndex((r) => "item" in r && r.item === selected);
  const { from, to } = listWindow(rows.length, Math.max(0, selectedRow), height);
  const itemsIn = (part: ListRow[]) => part.filter((r) => "item" in r).length;
  const above = itemsIn(rows.slice(0, from));
  const below = itemsIn(rows.slice(to));
  // With the group's separator scrolled away, the ▲ row names the group (day) of the first entry shown.
  const topRow = rows[from];
  const topGroup = from > 0 && groups && topRow && "item" in topRow ? groups[topRow.item] : undefined;
  // Named groups show as they are, days (and years) by their label.
  const label = (key: string, full: boolean) => (group ? key : periodLabel(key, full ? "always" : "other"));
  useMouse((e) => {
    const at = inArea(area, e.x, e.y);
    if (!at || !onPick || items.length === 0) return;
    if (e.kind === "wheel") return onPick(Math.max(0, Math.min(items.length - 1, selected + e.delta)));
    // The ▲/▼ rows jump to the far end, like Home and End.
    if (from > 0 && at.row === 0) return onPick(0);
    const index = from + at.row - (from > 0 ? 1 : 0);
    if (index >= to) return to < rows.length && at.row === height - 1 ? onPick(items.length - 1) : undefined;
    // A separator picks the first entry of its group.
    const row = rows[index];
    onPick("item" in row ? row.item : row.before);
    if ("item" in row && e.kind === "click") onClick?.(row.item);
  });
  if (items.length === 0) return <Text dimColor>{empty}</Text>;
  const width = area.width || 40;
  return (
    <>
      {from > 0 && <MoreRow arrow="▲" count={above} jumpKey="Home" group={topGroup && label(topGroup, false)} />}
      {rows.slice(from, to).map((row) => {
        if ("group" in row)
          return (
            // Keyed by the item below it: a day could come twice in an unordered list.
            <Text key={`group-${itemKey(items[row.before], row.before)}`} dimColor wrap="truncate">
              {ruleText(label(row.group, true), width)}
            </Text>
          );
        const index = row.item;
        const item = items[index];
        const isSelected = index === selected;
        if (!isSelected)
          return (
            <Text key={itemKey(item, index)} wrap="truncate">
              {render(item, false)}
            </Text>
          );
        // The selection spans the list's width, also past a short entry: a row of spaces in the
        // same style fills the rest. Without focus the selection stays visible but quiet.
        const style = { inverse: focused, bold: focused, backgroundColor: focused ? undefined : INACTIVE_SELECTION };
        return (
          <Box key={itemKey(item, index)} width={width} height={1}>
            <Box overflow="hidden">
              <Text wrap="truncate" {...style}>
                {render(item, true)}
              </Text>
            </Box>
            <Box flexGrow={1} flexBasis={0} overflow="hidden">
              <Text wrap="wrap" {...style}>
                {" ".repeat(width)}
              </Text>
            </Box>
          </Box>
        );
      })}
      {to < rows.length && <MoreRow arrow="▼" count={below} jumpKey="End" />}
    </>
  );
}

/** Modal box centred over the view (info dialog, confirmations). `width` and `height` include the border. */
export function Dialog({
  layout,
  width,
  height,
  borderColor = "cyan",
  children,
}: {
  layout: Layout;
  width: number;
  height: number;
  borderColor?: string;
  children: ReactNode;
}) {
  const top = Math.max(0, Math.floor((layout.rows - height) / 2));
  const left = Math.max(0, Math.floor((layout.columns - width) / 2));
  return (
    <Box
      position="absolute"
      top={top}
      left={left}
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      backgroundColor="#1b1f27"
      paddingX={1}
      overflow="hidden"
    >
      {children}
    </Box>
  );
}
