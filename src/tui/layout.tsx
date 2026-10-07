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
import { isListFold, isViewShown, LIST_WIDTH_SETTINGS, type ColumnWidth, type ListFold, type ListOrder, type ListWidth, type Settings } from "../settings.js";
import { useSetting, useSettings } from "./useSetting.js";
import { useMouse } from "./mouse.js";
import { useReload } from "./reload.js";
import { useUpdateInfo } from "./useUpdate.js";
import { VERSION } from "../version.js";
import { entryGroups, periodLabel, periodOf, ruleText, separatorsAt, type Period } from "./days.js";
import { PINNED_LABEL, type PinnedRows } from "../pinned.js";
import { centredBadge } from "./Preview.js";

/** `text` followed by spaces up to `width` columns. */
const padColumns = (text: string, width: number) => text + " ".repeat(Math.max(0, width - stringWidth(text)));

/** A short message of the app for the preview's bottom row, like "copied" (the list width after < or >). */
export const ScreenNoticeContext = createContext<string | undefined>(undefined);

export type Mode = "chat" | "git" | "plan" | "sessions" | "settings" | "monitor";

export interface Layout {
  columns: number;
  rows: number;
  listWidth: number;
  previewWidth: number;
  bodyHeight: number;
  /** `|`, `<` and `>` past the ends: the list or the preview takes the whole pane. */
  fold?: ListFold;
}

/** Each list width as a share of the pane's columns, kept within `min` and `max` columns. */
export const LIST_WIDTHS: Record<ColumnWidth, { share: number; min: number; max: number }> = {
  narrow: { share: 0.2, min: 16, max: 30 },
  normal: { share: 0.3, min: 20, max: 40 },
  wide: { share: 0.4, min: 24, max: 60 },
  wider: { share: 0.5, min: 30, max: 80 },
};

/** Columns the preview keeps at least: a wider list stops there, but never below the normal width. */
const MIN_PREVIEW = 20;

/** The columns of a list of `width` in a pane of `columns`. */
export function listColumns(columns: number, width: ColumnWidth): number {
  const of = (w: ColumnWidth) => Math.min(LIST_WIDTHS[w].max, Math.max(LIST_WIDTHS[w].min, Math.floor(columns * LIST_WIDTHS[w].share)));
  // list + border + padding + the preview
  return Math.min(of(width), Math.max(columns - 3 - MIN_PREVIEW, of("normal")));
}

/**
 * The layout of a list of `width`. At `hidden` the preview takes the pane, at `full` the list does; a detail
 * opened from the full list (`drilled`) shows like `hidden`. The side out of sight keeps the normal width.
 */
export function layoutOf(columns: number, rows: number, width: ListWidth = "normal", drilled = false): Layout {
  const fold = drilled ? "hidden" : isListFold(width) ? width : undefined;
  const listWidth = listColumns(columns, isListFold(width) ? "normal" : width);
  // list + border + padding
  const previewWidth = Math.max(MIN_PREVIEW, columns - listWidth - 3);
  return {
    columns,
    rows,
    listWidth: fold === "full" ? columns : listWidth,
    // Only the scroll bar's column beside it.
    previewWidth: fold === "hidden" ? Math.max(MIN_PREVIEW, columns - 1) : previewWidth,
    bodyHeight: Math.max(3, rows - 2),
    fold,
  };
}

/** The layout of each view, with the list width its setting gives (and a drilled detail); without a view, the normal width (dialogs). */
export function useLayouts(): (mode?: Mode, drilled?: boolean) => Layout {
  const { columns, rows } = useWindowSize();
  const settings = useSettings();
  return (mode, drilled) => layoutOf(columns, rows, mode ? settings[LIST_WIDTH_SETTINGS[mode]] : "normal", drilled);
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

/** The top bar's tabs, in order, with their number key. */
const TABS: { key: string; label: string; mode: Mode }[] = [
  { key: "1", label: "Chat", mode: "chat" },
  { key: "2", label: "Changes", mode: "git" },
  { key: "3", label: "Plan", mode: "plan" },
  { key: "4", label: "Sessions", mode: "sessions" },
  { key: "5", label: "Monitor", mode: "monitor" },
  { key: "6", label: "Settings", mode: "settings" },
];
const TABS_LEAD = "cco ";
const tabText = (tab: (typeof TABS)[number]) => ` ${tab.key} ${tab.label} `;

/** The tabs shown while `mode` is open: a hidden view shows its tab only while it is open (opened by a /cco:… command). */
function shownTabs(settings: Settings, mode: Mode) {
  return TABS.filter((t) => t.mode === mode || isViewShown(settings, t.mode));
}

/** The view whose tab is at column `x` of the top bar, or undefined. */
export function tabAt(x: number, settings: Settings, mode: Mode): Mode | undefined {
  let start = TABS_LEAD.length;
  for (const tab of shownTabs(settings, mode)) {
    const end = start + tabText(tab).length;
    if (x >= start && x < end) return tab.mode;
    start = end;
  }
  return undefined;
}

function Tabs({ mode, focused }: { mode: Mode; focused: boolean }) {
  const settings = useSettings();
  return (
    <Text>
      {/* Cyan is hard to read on the blue focus bar. */}
      <Text bold color={focused ? "whiteBright" : "cyan"}>
        {TABS_LEAD}
      </Text>
      {shownTabs(settings, mode).map((tab) =>
        tab.mode === mode ? (
          <Text key={tab.mode} inverse bold>
            {tabText(tab)}
          </Text>
        ) : (
          <Text key={tab.mode} dimColor={!focused}>
            {tabText(tab)}
          </Text>
        ),
      )}
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

/** A side folded away keeps its size, far below the screen, so no click or wheel reaches it. */
const hiddenArea = (width: number, height: number) => ({ x: 0, y: 1_000_000, width, height });

/**
 * The notice takes the bottom row for a moment, over whatever `content` shows there (also a plain message).
 * Ink does not clip the content here (its own overflow replaces this clip), so the row is filled to `fill`
 * columns to cover the content's last row.
 */
function withNotice(content: ReactNode, notice: string | undefined, width: number, height: number, fill = width): ReactNode {
  if (!notice) return content;
  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" height={height - 1}>
        {content}
      </Box>
      <Text wrap="truncate">{padColumns(centredBadge(notice, width), fill)}</Text>
    </Box>
  );
}

export function Screen({ layout, mode, status, list, preview, footer }: ScreenProps) {
  const notice = useContext(ScreenNoticeContext);
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
        {/* Not shrunk by a preview of plain text, whose width Yoga counts in full (Plan's "No plan in this session yet…"). */}
        {/* The side folded away stays rendered, out of sight and out of the mouse's reach, so it keeps its state. */}
        <Box
          display={layout.fold === "hidden" ? "none" : "flex"}
          flexDirection="column"
          width={layout.listWidth}
          height={layout.bodyHeight}
          flexShrink={0}
        >
          <AreaContext.Provider value={layout.fold === "hidden" ? hiddenArea(layout.listWidth, layout.bodyHeight) : { x: 0, y: 1, width: layout.listWidth, height: layout.bodyHeight }}>
            {layout.fold === "full" ? withNotice(list, notice, layout.listWidth, layout.bodyHeight) : list}
          </AreaContext.Provider>
        </Box>
        <Box
          display={layout.fold === "full" ? "none" : "flex"}
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderLeft={layout.fold !== "hidden"}
          borderDimColor
          paddingLeft={layout.fold === "hidden" ? 0 : 1}
          height={layout.bodyHeight}
        >
          <AreaContext.Provider
            value={
              layout.fold === "full"
                ? hiddenArea(layout.previewWidth, layout.bodyHeight)
                : { x: layout.fold === "hidden" ? 0 : layout.listWidth + 2, y: 1, width: layout.previewWidth, height: layout.bodyHeight }
            }
          >
            {/* Filled to the scroll bar's column. */}
            {layout.fold === "full" ? preview : withNotice(preview, notice, layout.previewWidth, layout.bodyHeight, layout.previewWidth + 1)}
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
  /**
   * The Pinned group (`ListFilter.pinned`): the rows in screen order, which replaces `shown` and `reversed`,
   * and the selected row; `choose` hears which row a click or the wheel picks, before `onPick`.
   */
  pinned?: PinnedRows & { choose?: (row: number) => void };
  /** A value whose change centres the selection once, e.g. when a view restored the selection stored last time. */
  centre?: unknown;
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
  /** The first item of the window, counting the ▲ row's place: what the next window starts from. */
  start: number;
  /** Items shown as entries: indices from..to (exclusive). */
  from: number;
  to: number;
  /** Items hidden above and below; a row with ▲/▼ takes the place of the first/last entry. */
  above: number;
  below: number;
}

/**
 * The rows a list keeps between the selection and its top or bottom edge:
 * it scrolls once the selection reaches its upper or lower third. Below six
 * rows only the ▲/▼ row, and with fewer than three not even that.
 */
export function scrollMargin(height: number): number {
  return height < 3 ? 0 : Math.max(1, Math.ceil(height / 3) - 1);
}

/**
 * Which of `count` items fit in `height` rows. The window stays at `previous`
 * (its last `start`) and moves only as far as needed to keep `margin` rows
 * around the selection; without `previous` the selection is centred. When
 * items are cut off, the first or last row becomes a "more" indicator.
 */
export function listWindow(count: number, selected: number, height: number, previous?: number, margin = scrollMargin(height)): ListWindow {
  if (count <= height) return { start: 0, from: 0, to: count, above: 0, below: 0 };
  const wanted =
    previous === undefined
      ? selected - Math.floor(height / 2)
      : Math.min(Math.max(previous, selected - (height - 1 - margin)), selected - margin);
  const start = Math.max(0, Math.min(wanted, count - height));
  // With fewer than three rows there is no room for indicators around the selection.
  const top = start > 0 && height >= 3;
  const bottom = start + height < count && height >= 3;
  const from = start + (top ? 1 : 0);
  const to = start + height - (bottom ? 1 : 0);
  return { start, from, to, above: from, below: count - to };
}

/** What a list keeps of its last window: where it started, the selected entry (key) and its row. */
export interface WindowState {
  start: number;
  key?: string;
  row: number;
  /** The entry picked with a click, while it stays selected. */
  clicked?: string;
  centre?: unknown;
}

/**
 * The window after `prev`, with the entry `key` selected in `row`. A new list
 * (or a new `centre`) centres it; an entry that only moved because entries
 * came or went around it keeps its place on screen; one picked with a click
 * stays under the pointer, also in the margin.
 */
export function nextWindow(prev: WindowState | undefined, count: number, row: number, height: number, key?: string, centre?: unknown): ListWindow {
  if (!prev || !Object.is(prev.centre, centre)) return listWindow(count, row, height);
  const same = key !== undefined && key === prev.key;
  const margin = key !== undefined && key === prev.clicked ? scrollMargin(Math.min(height, 3)) : undefined;
  return listWindow(count, row, height, same ? prev.start + row - prev.row : prev.start, margin);
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

/**
 * A list of entries with one selected, scrolled once the selection reaches
 * its upper or lower third (`nextWindow`). With `reversed`, it shows `items`
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
  if (all.pinned) return <PinnedList {...all} pinned={all.pinned} separators={separators} />;
  const props = all.shown ? shownOnly(all, all.shown) : all;
  const groups = groupKeys(props, props.items, separators);
  if (!props.reversed) return <ListRows {...props} {...separatorRows(props, groups)} />;
  const last = props.items.length - 1;
  const flip = (i: number) => last - i;
  return (
    <ListRows
      {...props}
      {...separatorRows(props, groups && [...groups].reverse())}
      items={[...props.items].reverse()}
      selected={flip(props.selected)}
      itemKey={(item, i) => props.itemKey(item, flip(i))}
      onPick={props.onPick && ((i) => props.onPick!(flip(i)))}
      onClick={props.onClick && ((i) => props.onClick!(flip(i)))}
    />
  );
}

/**
 * The group of each of `items` (in natural order): its named group, else its
 * day or year while separators are on. Days are taken in the natural order,
 * so an item without a time joins the one before it.
 */
function groupKeys<T>(props: ListProps<T>, items: T[], separators: boolean): string[] | undefined {
  const period = props.period ?? "day";
  if (props.group) return items.map(props.group);
  return separators && props.time ? entryGroups(items.map((item) => periodOf(props.time!(item), period)), period) : undefined;
}

/** How a group key reads: a named group as it is, a day (or year) by its label, with the year in a separator. */
const groupLabel = <T,>(props: ListProps<T>, key: string, full: boolean) => (props.group ? key : periodLabel(key, full ? "always" : "other"));

/** The separators above the items (groups in display order) and the group the ▲ row names for each. */
function separatorRows<T>(props: ListProps<T>, groups: string[] | undefined): Pick<RowsProps, "heads" | "tops"> {
  return {
    heads: separatorsAt(groups).map((key) => (key === undefined ? undefined : [groupLabel(props, key, true)])),
    tops: groups?.map((key) => groupLabel(props, key, false)),
  };
}

/**
 * The list with a Pinned group: `pinned.order` from the top, the pinned
 * entries under "★ Pinned", then the whole list with its own separators, as
 * without the group, after a plain line where it starts without one. An
 * entry can show twice, so the rows are what is selected and picked.
 */
function PinnedList<T>({ pinned, separators, ...props }: ListProps<T> & { pinned: NonNullable<ListProps<T>["pinned"]>; separators: boolean }) {
  const { order, count, row, choose } = pinned;
  // The rest's groups are taken in natural order, like without the group.
  const rest = order.slice(count).sort((a, b) => a - b);
  const keys = groupKeys(props, rest.map((i) => props.items[i]), separators);
  const keyOf = new Map(rest.map((i, n) => [i, keys?.[n]]));
  const heads: (string[] | undefined)[] = [];
  const tops: (string | undefined)[] = [];
  let previous: string | undefined;
  order.forEach((i, at) => {
    if (at < count) {
      heads.push(at === 0 ? [PINNED_LABEL] : undefined);
      tops.push(PINNED_LABEL);
      return;
    }
    const key = keyOf.get(i);
    if (key !== undefined && (at === count || key !== previous)) heads.push([groupLabel(props, key, true)]);
    else heads.push(at === count ? [""] : undefined);
    previous = key;
    tops.push(key === undefined ? undefined : groupLabel(props, key, false));
  });
  const pick = (handler: ((index: number) => void) | undefined) =>
    handler &&
    ((at: number) => {
      choose?.(at);
      handler(order[at]);
    });
  return (
    <ListRows
      {...props}
      items={order.map((i) => props.items[i])}
      selected={row}
      // The pinned copies keyed apart from their rows below.
      itemKey={(item, at) => (at < count ? "★" : "") + props.itemKey(item, order[at])}
      onPick={pick(props.onPick)}
      onClick={props.onClick && ((at) => props.onClick!(order[at]))}
      heads={heads}
      tops={tops}
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

/** A row of a list: an item (by index) or a separator (its label) before a group's (day's) first item. */
type ListRow = { item: number } | { group: string; before: number };

/** The rows of `count` items with the separators of `heads` (labels, in display order) above them. */
export function listRows(count: number, heads: (string[] | undefined)[]): ListRow[] {
  const rows: ListRow[] = [];
  for (let i = 0; i < count; i++) {
    for (const group of heads[i] ?? []) rows.push({ group, before: i });
    rows.push({ item: i });
  }
  return rows;
}

/** What ListRows adds to a list's props: the separators above each item, and each item's group for the ▲ row. */
interface RowsProps {
  heads: (string[] | undefined)[];
  tops: (string | undefined)[] | undefined;
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

function ListRows<T>({ items, selected, height, empty, itemKey, render, onPick, onClick, heads, tops, centre }: ListProps<T> & RowsProps) {
  const focused = useFocused();
  const area = useContext(AreaContext);
  const rows = listRows(items.length, heads);
  const selectedRow = Math.max(0, rows.findIndex((r) => "item" in r && r.item === selected));
  const key = items[selected] === undefined ? undefined : itemKey(items[selected], selected);
  // The window is kept from render to render, but only while the list is longer than its rows.
  const kept = useRef<WindowState | undefined>(undefined);
  const { start, from, to } = nextWindow(kept.current, rows.length, selectedRow, height, key, centre);
  const clicked = key !== undefined && key === kept.current?.clicked ? key : undefined;
  kept.current = rows.length > height ? { start, key, row: selectedRow, clicked, centre } : undefined;
  const itemsIn = (part: ListRow[]) => part.filter((r) => "item" in r).length;
  const above = itemsIn(rows.slice(0, from));
  const below = itemsIn(rows.slice(to));
  // With the group's separator scrolled away, the ▲ row names the group (day) of the first entry shown.
  const topRow = rows[from];
  const topGroup = from > 0 && tops && topRow && "item" in topRow ? tops[topRow.item] : undefined;
  useMouse((e) => {
    const at = inArea(area, e.x, e.y);
    if (!at || !onPick || items.length === 0 || (e.kind !== "click" && e.kind !== "wheel")) return;
    if (e.kind === "wheel") return onPick(Math.max(0, Math.min(items.length - 1, selected + e.delta)));
    // The ▲/▼ rows jump to the far end, like Home and End.
    if (from > 0 && at.row === 0) return onPick(0);
    const index = from + at.row - (from > 0 ? 1 : 0);
    if (index >= to) return to < rows.length && at.row === height - 1 ? onPick(items.length - 1) : undefined;
    // A separator picks the first entry of its group.
    const row = rows[index];
    const picked = "item" in row ? row.item : row.before;
    // The picked entry stays under the pointer, also in the margin.
    if (e.kind === "click" && kept.current) kept.current.clicked = itemKey(items[picked], picked);
    onPick(picked);
    if ("item" in row && e.kind === "click") onClick?.(row.item);
  });
  if (items.length === 0) return <Text dimColor>{empty}</Text>;
  const width = area.width || 40;
  return (
    <>
      {from > 0 && <MoreRow arrow="▲" count={above} jumpKey="Home" group={topGroup} />}
      {rows.slice(from, to).map((row) => {
        if ("group" in row)
          return (
            // Keyed by the item below it: a day could come twice in an unordered list.
            <Text key={`group-${row.group}-${itemKey(items[row.before], row.before)}`} dimColor wrap="truncate">
              {ruleText(row.group, width)}
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
