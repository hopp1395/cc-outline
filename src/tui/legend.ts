import stringWidth from "string-width";
import type { Mode } from "./layout.js";

/** A mark of a list: how it is drawn (SGR colour code) and what it says in short; without a mark, the short text is drawn in the colour. */
export interface ShortMark {
  mark: string;
  /** The SGR code of its colour, e.g. "32" for green; none: the text's colour. */
  color?: string;
  short: string;
}

/** A mark of the Sessions list, which the Settings rows with `legend` also explain in full. */
export interface LegendMark extends ShortMark {
  text: string;
}

/** Every mark a row of the Sessions list can carry, in pairs that belong together (the dialog shows two to a line). */
export const SESSION_LEGEND: LegendMark[] = [
  {
    mark: "●",
    color: "32",
    short: "active",
    text: "the session the other views show; it blinks while Claude works and blinks yellow on and off while Claude waits for you",
  },
  { mark: "▶", color: "32", short: "runs elsewhere", text: "runs in another Claude Code, blinking like ●" },
  { mark: "◌", color: "2", short: "background", text: "ran in the background: started with `claude -p` or the Agent SDK, or run by the Claude Code daemon" },
  { mark: "∅", color: "2", short: "folder gone", text: "its folder is gone; with other folders listed, the project's name is struck through" },
  { mark: "⇢", color: "35", short: "to other account", text: "continued in another account" },
  { mark: "⇠", color: "35", short: "from other account", text: "the copy of a session continued here from another account" },
  { mark: "★", color: "33", short: "marked", text: "marked (`Space`); `Shift+↑/↓` jump between the marked ones" },
  { mark: "▌", short: "account colour", text: "the account's colour (or its avatar), while other accounts are listed" },
  // No mark of its own: the name itself is drawn in the colour, as in the list.
  { mark: "", color: "36", short: "project folder", text: "the project's folder name, cyan, while other folders are listed" },
  { mark: "„“", color: "2", short: "first prompt", text: "no `/rename` title: the first prompt stands in for it, dim and quoted" },
  { mark: "◈", color: "36", short: "remote", text: "a Remote Control session read from claude.ai that runs on another machine (setting remote API)" },
  { mark: "⇄", color: "36", short: "connected", text: "a session of this machine that is connected to claude.ai (Remote Control), also in the Claude app" },
  { mark: "⚠", color: "33", short: "waits for you", text: "a remote session whose Claude waits for an answer (a permission or a question), blinking on and off; its ◈ blinks while Claude works there" },
  { mark: "◎", color: "34", short: "session viewers", text: "session viewers of it run (Enter, open one); `◎2` and up count them" },
  {
    mark: "▣",
    color: "36",
    short: "images",
    text: "with the count after it: images pasted into its prompts and images and PDFs its tools returned; `o` lists them with the @-mentioned files",
  },
  { mark: "◇", color: "35", short: "workflows", text: "Claude started dynamic workflows there; `◇2` and up count them, the details list them" },
];

/**
 * A mark drawn in its colour, closed by its own reset (dim 22, colours 39): a full reset (0) would also clear the
 * background, and the dialog's text after the mark would stand on the terminal's instead of the dialog's.
 */
export const legendMark = (m: ShortMark) => (m.color ? `\u001b[${m.color}m${m.mark}\u001b[${m.color === "2" ? "22" : "39"}m` : m.mark);

/** What a mark says in short, after the mark padded to `markWidth`; without a mark, the short text in the mark's colour. */
export function legendCell(m: ShortMark, markWidth: number): string {
  if (!m.mark) return legendMark({ ...m, mark: m.short });
  return `${legendMark(m)}${" ".repeat(markWidth - stringWidth(m.mark))} ${m.short}`;
}

/** The columns `legendCell` takes. */
export const legendCellWidth = (m: ShortMark, markWidth: number) => (m.mark ? markWidth + 1 : 0) + stringWidth(m.short);

/** The marks of `marks` in short, two to a line where they fit in `width` columns, else one a line, the marks in a column. */
export function legendLines(marks: ShortMark[], width: number): string[] {
  const markWidth = Math.max(...marks.map((m) => stringWidth(m.mark)));
  const cell = (m: ShortMark) => legendCell(m, markWidth);
  const cellWidth = Math.max(...marks.map((m) => legendCellWidth(m, markWidth)));
  const gap = 3;
  if (2 * cellWidth + gap > width) return marks.map(cell);
  const lines: string[] = [];
  for (let i = 0; i < marks.length; i += 2) {
    const [left, right] = [marks[i]!, marks[i + 1]];
    const pad = " ".repeat(cellWidth - legendCellWidth(left, markWidth) + gap);
    lines.push(right ? `${cell(left)}${pad}${cell(right)}` : cell(left));
  }
  return lines;
}

const MARKED: ShortMark = { mark: "★", color: "33", short: "marked" };
const MORE: ShortMark = { mark: "", color: "36", short: "↓ more ↓ reads the rest" };
/** Claude's orange, of the spinner and the slash commands. */
const ORANGE = "38;2;217;119;87";

/** The marks each view's list can show, in pairs that belong together, for the info dialog's Legend page. */
/** The marks of the Remote Control Viewer's sessions (`cco rc-viewer`), ahead of the turns' (`LEGENDS.chat`) on its legend page. */
export const RC_VIEWER_LEGEND: ShortMark[] = [
  { mark: "⚠", color: "33", short: "waits for you (blinks)" },
  { mark: "●", color: "32", short: "works (dims) / idle" },
  { mark: "●", color: "32", short: "just finished (blinks)" },
  { mark: "∅", color: "2", short: "ended" },
  { mark: "◈", color: "36", short: "remote" },
  { mark: "⇄", color: "36", short: "answered here (dim: steer remote off)" },
  { mark: "▌", short: "account colour" },
  { mark: "3m", color: "2", short: "time in its state" },
];

export const LEGENDS: Record<Mode, ShortMark[]> = {
  chat: [
    { mark: "⠋", color: ORANGE, short: "Claude works on it" },
    { mark: "⊘", color: "31", short: "interrupted" },
    { mark: "↳", color: "36", short: "typed while Claude worked" },
    { mark: "", color: ORANGE, short: "/command" },
    { mark: "⤷", color: "34", short: "continued in a new session" },
    { mark: "⟳", color: "34", short: "compacted" },
    { mark: "↩", color: "35", short: "agent report, message" },
    { mark: "↩", color: "32", short: "task done" },
    { mark: "↩", color: "31", short: "task failed or stopped" },
    { mark: "↩", color: "33", short: "task, other status" },
    { mark: "◆", color: "35", short: "subagents, with the count" },
    { mark: "▣", color: "36", short: "images, with the count" },
    MARKED,
  ],
  git: [
    { mark: "M", color: "33", short: "modified" },
    { mark: "D", color: "31", short: "deleted" },
    { mark: "A", color: "32", short: "added" },
    { mark: "?", color: "32", short: "untracked" },
    { mark: "R", color: "34", short: "renamed" },
    { mark: "C", color: "34", short: "copied" },
    { mark: "U", color: "35", short: "conflict" },
    { mark: "+-", color: "2", short: "lines added, removed" },
    { mark: "──", color: "2", short: "repository · branch" },
    { mark: "──", color: "33", short: "rebase, merge… under way" },
    MARKED,
    MORE,
  ],
  plan: [
    { mark: "✎", color: "36", short: "being written" },
    { mark: "●", color: "33", short: "waits for approval" },
    { mark: "✓", color: "32", short: "approved" },
    { mark: "✗", color: "31", short: "rejected" },
    MARKED,
  ],
  sessions: [...SESSION_LEGEND, MORE],
  monitor: [
    { mark: "12", color: "2", short: "responses that day" },
    { mark: "✗", color: "31", short: "errors that day" },
    MARKED,
    MORE,
  ],
  todo: [
    { mark: "○", color: "2", short: "open" },
    { mark: "◐", color: "33", short: "sent to Claude" },
    { mark: "✓", color: "32", short: "done" },
    { mark: "◐", color: "33", short: "list with an item sent to Claude" },
    { mark: "☰", short: "list" },
  ],
  accounts: [
    { mark: "●", short: "active, in its colour" },
    { mark: "○", short: "other, in its colour" },
    { mark: "🦊", short: "its avatar" },
    { mark: "○", color: "31", short: "in the trash" },
    MARKED,
  ],
  settings: [
    { mark: "", color: "33", short: "value not the default" },
    { mark: "", color: "33", short: "new (release)" },
    { mark: "✚", short: "check (doctor)" },
    { mark: "", color: "32", short: "installed (release)" },
    { mark: "↺", short: "reset, restart" },
    { mark: "↑", color: "33", short: "update out" },
    { mark: "●", short: "active account" },
    { mark: "↻", color: "33", short: "restart: updated" },
    { mark: "○", short: "other account" },
    { mark: "", short: "badge: avatar or colour" },
    MARKED,
  ],
};
