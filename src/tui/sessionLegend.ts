/** A mark of the Sessions list: how it is drawn (SGR colour code), what it says in short and in full. */
export interface LegendMark {
  mark: string;
  /** The SGR code of its colour, e.g. "32" for green; none: the text's colour. */
  color?: string;
  short: string;
  text: string;
}

/** Every mark a row of the Sessions list can carry, in the order they stand in the row. */
export const SESSION_LEGEND: LegendMark[] = [
  { mark: "★", color: "33", short: "marked", text: "marked (`Space`); `Shift+↑/↓` jump between the marked ones" },
  { mark: "▌", short: "account", text: "the account's colour (or its avatar), while other accounts are listed" },
  {
    mark: "●",
    color: "32",
    short: "active",
    text: "the session the other views show; it blinks while Claude works and is yellow while Claude waits for you",
  },
  { mark: "▶", color: "32", short: "runs elsewhere", text: "runs in another Claude Code, blinking and yellow like ●" },
  { mark: "∅", color: "2", short: "folder gone", text: "its folder is gone; with other folders listed, the project's name is struck through" },
  { mark: "⇢", color: "35", short: "went on in another account", text: "continued in another account" },
  { mark: "⇠", color: "35", short: "came from one", text: "the copy of a session continued here from another account" },
  { mark: "◌", color: "2", short: "background", text: "ran in the background: started with `claude -p` or the Agent SDK, or run by the Claude Code daemon" },
  { mark: "name", color: "36", short: "project", text: "the project's folder (cyan), while other folders are listed" },
  { mark: "„…“", color: "2", short: "first prompt", text: "no `/rename` title: the first prompt stands in for it, dim and quoted" },
];

/** A mark drawn in its colour. */
export const legendMark = (m: LegendMark) => (m.color ? `\u001b[${m.color}m${m.mark}\u001b[0m` : m.mark);
