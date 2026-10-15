import { settings } from "./en/settings.js";

/**
 * The English texts, the source of every language: `de.ts` must have the same keys with the same
 * parameters (`Messages`), which the type checker makes sure of. A text with parameters is a function.
 */
export const en = {
  settings,
  tabs: {
    accounts: "Accounts",
    chat: "Chat",
    git: "Changes",
    plan: "Plan",
    sessions: "Sessions",
    monitor: "Monitor",
    settings: "Settings",
  },
  progress: {
    reopenByHand: "The viewer cannot reopen itself here: close it with q and open it again.",
    copyCommands: "copy commands",
    close: "close",
    cancel: "cancel",
    wait: "Please wait, this cannot be cancelled.",
  },
  placement: {
    title: "Move cco",
    reopens: "The viewer reopens there; this session remembers the place.",
    remembered: "No Windows Terminal or tmux: remembered for the next start.",
    choose: "choose",
    cancel: "cancel",
  },
  app: {
    noSessionFixed: "a viewer of one session (--session) continues none",
    noSessionUnpaired: "this viewer follows no Claude Code: attach it in Sessions",
    noSessionYet: "there is no session yet",
    restartTitle: "Restart the viewer",
    restarting: "Restarting",
    notReopened: "The viewer did not reopen",
    ctrlC: "Ctrl+C does not quit: q does",
    width: (width: string) => `width: ${width}`,
    quitTitle: "Quit cco?",
    quitWindow: "The window closes; Sessions opens another one (Enter).",
    quitPane: "The pane closes; a /cco:… command opens it again.",
  },
  days: {
    weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    /** "Sun 27 Sep", with the year "Sun 27 Sep 2026". */
    label: (weekday: string, day: number, month: string, year?: number) => `${weekday} ${day} ${month}${year === undefined ? "" : ` ${year}`}`,
  },
  languageDialog: {
    title: "Language",
    question: "Your operating system is set to German. Should cco speak German?",
    yes: "Yes, German",
    yesDetail: "cco follows the operating system's language",
    no: "No, English",
    noDetail: "cco stays in English",
    hint: "You can change it any time: Settings, language.",
  },
};

export type Messages = typeof en;
