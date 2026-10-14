import stringWidth from "string-width";

/** A mark of the Sessions list: how it is drawn (SGR colour code), what it says in short and in full; without a mark, the short text is drawn in the colour. */
export interface LegendMark {
  mark: string;
  /** The SGR code of its colour, e.g. "32" for green; none: the text's colour. */
  color?: string;
  short: string;
  text: string;
}

/** Every mark a row of the Sessions list can carry, in pairs that belong together (the dialog shows two to a line). */
export const SESSION_LEGEND: LegendMark[] = [
  {
    mark: "●",
    color: "32",
    short: "active",
    text: "the session the other views show; it blinks while Claude works and is yellow while Claude waits for you",
  },
  { mark: "▶", color: "32", short: "runs elsewhere", text: "runs in another Claude Code, blinking and yellow like ●" },
  { mark: "◌", color: "2", short: "background", text: "ran in the background: started with `claude -p` or the Agent SDK, or run by the Claude Code daemon" },
  { mark: "∅", color: "2", short: "folder gone", text: "its folder is gone; with other folders listed, the project's name is struck through" },
  { mark: "⇢", color: "35", short: "to other account", text: "continued in another account" },
  { mark: "⇠", color: "35", short: "from other account", text: "the copy of a session continued here from another account" },
  { mark: "★", color: "33", short: "marked", text: "marked (`Space`); `Shift+↑/↓` jump between the marked ones" },
  { mark: "▌", short: "account colour", text: "the account's colour (or its avatar), while other accounts are listed" },
  // No mark of its own: the name itself is drawn in the colour, as in the list.
  { mark: "", color: "36", short: "project folder", text: "the project's folder name, cyan, while other folders are listed" },
  { mark: "„“", color: "2", short: "first prompt", text: "no `/rename` title: the first prompt stands in for it, dim and quoted" },
];

/**
 * A mark drawn in its colour, closed by its own reset (dim 22, colours 39): a full reset (0) would also clear the
 * background, and the dialog's text after the mark would stand on the terminal's instead of the dialog's.
 */
export const legendMark = (m: LegendMark) => (m.color ? `\u001b[${m.color}m${m.mark}\u001b[${m.color === "2" ? "22" : "39"}m` : m.mark);

/** What a mark says in short, after the mark padded to `markWidth`; without a mark, the short text in the mark's colour. */
export function legendCell(m: LegendMark, markWidth: number): string {
  if (!m.mark) return legendMark({ ...m, mark: m.short });
  return `${legendMark(m)}${" ".repeat(markWidth - stringWidth(m.mark))} ${m.short}`;
}

/** The columns `legendCell` takes. */
export const legendCellWidth = (m: LegendMark, markWidth: number) => (m.mark ? markWidth + 1 : 0) + stringWidth(m.short);
