import type { Turn } from "../transcript/parse.js";
import type { SessionActivity } from "../transcript/trash.js";

/**
 * What Enter in Sessions can do with a session:
 * - `stay`/`detach`: the viewer's own session; detach leaves its Claude Code and follows the project's newest.
 * - `switch`: bring the tab of the Claude Code the session runs in to the front.
 * - `attach`: pair the viewer with that Claude Code, staying where it is.
 * - `here`: continue it in the viewer's own Claude Code (`/resume`).
 * - `window`: continue it in a new window, where its hook opens a viewer of its own; `window-attach` (only for a
 *   viewer without a Claude Code): and move this viewer next to it, paired.
 * - `move`: bring a session whose folder is gone into the viewer's project folder.
 * - `rename`: give it a new title (`/rename`), only while it runs nowhere.
 * - `export`: write it (or the marked sessions) into a zip archive; `import`: read the sessions of one.
 * - `account`: copy it into another account's config folder and continue it there, in a new window.
 * - `viewer`: open a viewer of it (the chat only, live) in a new window; `viewer-front`: bring the one opened last
 *   to the front.
 * - `folder`: open the folder it ran in, in the file manager.
 * - `copy`: copy the command that continues it.
 */
export type SessionAction = "stay" | "detach" | "switch" | "attach" | "here" | "window" | "window-attach" | "move" | "rename" | "export" | "import" | "account" | "viewer" | "viewer-front" | "rcViewer" | "folder" | "copy";

export interface ChoiceOption<T extends string = string> {
  id: T;
  label: string;
  /** One dim line below the label. */
  detail: string;
  /** Why it cannot be chosen now; shown instead of the detail. */
  disabled?: string;
  /** Hard to undo: shown in red, below a "Danger zone" line (above the first such option). */
  danger?: boolean;
}

/** The Claude Code a viewer belongs to, as far as continuing a session in it matters. */
export interface PairedClaude {
  /** Its session has no turn yet but a /clear at the start: nothing is lost by leaving it. */
  empty: boolean;
  /** What it does now (~/.claude/sessions/<pid>.json); undefined for versions that write no status. */
  activity?: SessionActivity;
  /** The command is typed into its pane (tmux), or copied for the user to paste. */
  method: "keys" | "clipboard";
}

/** Where a session stands, seen from the viewer. */
export interface SessionSituation {
  /** The Claude Code the viewer belongs to; none for a viewer started by hand. */
  paired?: PairedClaude;
  /** `current`: the session the paired viewer shows; `active`: it runs in a(nother) Claude Code; `inactive`: nowhere. */
  state: "current" | "active" | "inactive";
  /** Why the viewer cannot attach to the Claude Code it runs in (it has a viewer of its own). */
  attachBlocked?: string;
  /** The session ran in another project folder (its name, shortened): /resume cannot find it. */
  otherFolder?: string;
  /** Its folder is gone. */
  folderMissing?: boolean;
  /** Its folder is gone and it can move into the viewer's: the gone folder's name, shortened. */
  movable?: string;
  /** The viewer's project folder (its name, shortened): where imported and moved sessions go. */
  here?: string;
  /** How many sessions are marked: export takes them instead of this one. */
  marked?: number;
  /** The emails of the other accounts signed in on this machine: the session can continue in one of them. */
  accounts?: string[];
  /**
   * The email of the account the session belongs to, with two or more accounts found: the window option names it.
   */
  account?: string;
  /** The session is another account's: only switching to it, continuing it in a new window there and copying the command can be chosen. */
  foreign?: boolean;
  /** Windows Terminal or tmux runs the viewer: tabs can be switched and windows opened. */
  terminal: boolean;
  /** How many viewers of it run in windows of their own (◎). */
  viewers?: number;
  /** The Remote Control Viewer (`cco rc-viewer`): whether it runs, and whether it lists the session (running, or active today). */
  rcViewer?: { runs: boolean; listed: boolean };
  /** The folder it ran in, as `folder` names it (`~` for the home folder). */
  folder: string;
  /** The command `copy` copies. */
  command: string;
}

/** A session without a prompt yet: no turns, or only the /clear it began with. */
export function isEmptySession(turns: Turn[]): boolean {
  return turns.every((t, i) => i === 0 && /^\/clear(\s|$)/.test(t.prompt));
}

const BUSY: Partial<Record<SessionActivity, string>> = {
  busy: "Claude is working; continue it here once it is done",
  waiting: "Claude waits for an answer; continue it here once it has one",
};

const NO_TERMINAL = "no Windows Terminal or tmux";
/** Why the options that work on this account's folder cannot be chosen for another account's session. */
export const OWN_ONLY = "only for sessions of this account";
/** A running Claude Code keeps its title and writes it again: only it can rename its session. */
const RUNS = "it runs: use /rename in its Claude Code";

/**
 * The options Enter offers for a session and the one selected at first: the preferred one that can be
 * chosen, else copying the command, which always can. See the matrix in docs/dev/sessions.md.
 */
export function sessionOptions(s: SessionSituation): { options: ChoiceOption<SessionAction>[]; initial: number } {
  const { paired } = s;
  const own = s.foreign ? OWN_ONLY : undefined;
  const copy: ChoiceOption<SessionAction> = { id: "copy", label: "Copy the command", detail: s.command };
  const noTerminal = s.terminal ? undefined : NO_TERMINAL;
  let options: ChoiceOption<SessionAction>[];
  // Ids in the order they are preferred as the first selection.
  let preferred: SessionAction[];
  if (s.state === "current") {
    options = [
      { id: "stay", label: "Stay attached", detail: "nothing changes" },
      { id: "detach", label: "Detach this viewer", detail: "it stays open and follows the project's newest session" },
    ];
    preferred = ["stay"];
  } else if (s.state === "active") {
    const switchTo: ChoiceOption<SessionAction> = { id: "switch", label: "Switch to its Claude Code tab", detail: "it runs in another Claude Code", disabled: noTerminal };
    const attach: ChoiceOption<SessionAction> = paired
      ? { id: "attach", label: "Attach this viewer there", detail: "it stays here; this Claude Code is left without one", disabled: own ?? s.attachBlocked }
      : { id: "attach", label: "Attach this viewer", detail: "it stays here and follows that Claude Code", disabled: own ?? s.attachBlocked };
    options = paired ? [switchTo, attach] : [attach, switchTo];
    preferred = paired ? ["switch"] : ["attach", "switch"];
  } else {
    const gone = s.folderMissing ? "its folder is gone" : undefined;
    const as = s.account ? ` as ${s.account}` : "";
    const window: ChoiceOption<SessionAction> = {
      id: "window",
      label: "Continue it in a new Claude Code window",
      detail: paired || s.foreign ? `claude --resume${as}` : `claude --resume${as}; the viewer stays here, unpaired`,
      disabled: gone ?? noTerminal,
    };
    const windowAttach: ChoiceOption<SessionAction> = {
      id: "window-attach",
      label: "Continue it in a new Claude Code window and attach",
      detail: "the viewer moves next to it",
      disabled: own ?? gone ?? noTerminal,
    };
    if (s.foreign) {
      // /resume in this viewer's Claude Code cannot reach another account's session.
      options = [{ id: "here", label: "Continue it in this Claude Code", detail: "", disabled: OWN_ONLY }, window, ...(paired ? [] : [windowAttach])];
      preferred = ["window"];
    } else if (paired) {
      const how = paired.method === "keys" ? "/resume is typed in" : "/resume is copied for you to paste";
      const here: ChoiceOption<SessionAction> = {
        id: "here",
        label: "Continue it in this Claude Code",
        detail: paired.empty ? `it has no prompt yet: ${how}` : `it leaves its session: ${how}`,
        disabled: gone ?? (s.otherFolder !== undefined ? `ran in ${s.otherFolder}, not in this folder` : paired.activity ? BUSY[paired.activity] : undefined),
      };
      options = [here, window];
      preferred = paired.empty ? ["here", "window"] : ["window"];
    } else {
      options = [windowAttach, window];
      preferred = ["window-attach", "window"];
    }
  }
  const into = s.here ? ` into ${s.here}` : "";
  if (s.state === "inactive" && s.movable !== undefined) {
    options.unshift({ id: "move", label: "Move it to this project", detail: `from ${s.movable}${into}`, disabled: own });
    if (!own) preferred = ["move"];
  }
  const marked = s.marked ?? 0;
  // Only offered with a second account signed in on this machine.
  const accounts = s.accounts ?? [];
  if (accounts.length > 0)
    options.push({
      id: "account",
      label: accounts.length === 1 ? `Continue it in ${accounts[0]}…` : "Continue it in another account…",
      detail: accounts.length === 1 ? "a copy, in a new Claude Code window" : `a copy in one of ${accounts.length} other accounts, in a new Claude Code window`,
      disabled: own ?? (s.folderMissing ? "its folder is gone" : undefined),
    });
  options.push(...viewerOptions(s.viewers ?? 0, s.terminal));
  // Another account's folder is on this machine too.
  options.push({ id: "folder", label: "Open its folder", detail: s.folder, disabled: s.folderMissing ? "its folder is gone" : undefined });
  options.push(
    { id: "rename", label: "Rename it", detail: "a new title, as /rename gives it", disabled: own ?? (s.state === "inactive" ? undefined : RUNS) },
    marked > 0 && !own
      ? { id: "export", label: `Export ${marked} marked session${marked === 1 ? "" : "s"}`, detail: "into a zip archive in the downloads folder" }
      : { id: "export", label: "Export it", detail: "into a zip archive in the downloads folder", disabled: own },
    { id: "import", label: "Import sessions…", detail: `from a cco-session-export zip${into}`, disabled: own },
    copy,
  );
  // Last, so the numbers of the others stay: the Remote Control Viewer, which shows every session.
  if (s.rcViewer) options.push(rcViewerOption(s.rcViewer, s.terminal));
  // When nothing else can be chosen (folder gone, another account's without a terminal), viewing it can.
  const first = [...preferred, "viewer"].map((id) => options.findIndex((o) => o.id === id && !o.disabled)).find((i) => i >= 0);
  return { options, initial: first ?? options.indexOf(copy) };
}

/**
 * A session viewer of the session (a window of its own), with a prompt line (a `remote` one's only with steer remote): another
 * window each time, and bringing the one opened last to the front while `viewers` run. Without a terminal to open a
 * window in, it copies the command; it can always be chosen.
 */
export function viewerOptions(viewers: number, terminal: boolean, remote?: { control: boolean }): ChoiceOption<"viewer" | "viewer-front">[] {
  return [
    {
      id: "viewer",
      label: viewers > 0 ? "Open another session viewer" : "Open it in a session viewer",
      detail: !terminal
        ? "no Windows Terminal or tmux: copies the command that opens it"
        : !remote
          ? "its chat, live, with a prompt line while it runs in a Claude Code"
          : remote.control
            ? "its chat, live, with a prompt line"
            : "its chat, live; steer remote is off, so nothing can be sent",
    },
    ...(viewers > 0
      ? [
          {
            id: "viewer-front" as const,
            label: "Bring its session viewer to the front",
            detail: viewers === 1 ? "the one open now" : `the one opened last of ${viewers}`,
            disabled: terminal ? undefined : NO_TERMINAL,
          },
        ]
      : []),
  ];
}

/**
 * The Remote Control Viewer (`cco rc-viewer`) with the session selected: opened in its window, or the one that runs brought to the
 * front. It lists the sessions that run and those active today only.
 */
export function rcViewerOption(rcViewer: { runs: boolean; listed: boolean }, terminal: boolean): ChoiceOption<"rcViewer"> {
  return {
    id: "rcViewer",
    label: "Watch it in the Remote Control Viewer",
    detail: !terminal && !rcViewer.runs ? "no Windows Terminal or tmux: copies cco rc-viewer" : rcViewer.runs ? "the Remote Control Viewer comes to the front with it selected" : "opens the Remote Control Viewer, a window with every session, with it selected",
    disabled: rcViewer.listed ? undefined : "the Remote Control Viewer lists the sessions that run and those of today",
  };
}

/** What the help line says Enter does: the action selected at first, or for the viewer's own session that it can detach. */
export function enterLabel(s: SessionSituation): string {
  if (s.state === "current") return "↵ detach…";
  const { options, initial } = sessionOptions(s);
  const LABELS: Record<SessionAction, string> = {
    stay: "stay",
    detach: "detach",
    switch: "switch",
    attach: "attach",
    here: "resume in this Claude Code",
    window: "new Claude Code",
    "window-attach": "new Claude Code + attach",
    move: "move to this project",
    rename: "rename",
    export: "export",
    import: "import",
    account: "other account",
    viewer: "session viewer",
    "viewer-front": "viewer to front",
    rcViewer: "Remote Control Viewer",
    folder: "open folder",
    copy: "copy",
  };
  return `↵ ${LABELS[options[initial]!.id]}`;
}
