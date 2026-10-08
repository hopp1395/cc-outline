import type { Turn } from "../transcript/parse.js";
import type { SessionActivity } from "../transcript/trash.js";

/**
 * What Enter in Sessions can do with a session:
 * - `stay`/`detach`: the viewer's own session; detach leaves its Claude Code and follows the project's newest.
 * - `switch`: bring the tab of the Claude Code the session runs in to the front.
 * - `attach`: pair the viewer with that Claude Code, staying where it is.
 * - `here`: continue it in the viewer's own Claude Code (`/resume`).
 * - `window`: continue it in a new window; `window-attach`: and move the viewer next to it, paired.
 * - `move`: bring a session whose folder is gone into the viewer's project folder.
 * - `rename`: give it a new title (`/rename`), only while it runs nowhere.
 * - `export`: write it (or the marked sessions) into a zip archive; `import`: read the sessions of one.
 * - `copy`: copy the command that continues it.
 */
export type SessionAction = "stay" | "detach" | "switch" | "attach" | "here" | "window" | "window-attach" | "move" | "rename" | "export" | "import" | "copy";

export interface ChoiceOption<T extends string = string> {
  id: T;
  label: string;
  /** One dim line below the label. */
  detail: string;
  /** Why it cannot be chosen now; shown instead of the detail. */
  disabled?: string;
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
  /** Windows Terminal or tmux runs the viewer: tabs can be switched and windows opened. */
  terminal: boolean;
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
/** A running Claude Code keeps its title and writes it again: only it can rename its session. */
const RUNS = "it runs: use /rename in its Claude Code";

/**
 * The options Enter offers for a session and the one selected at first: the preferred one that can be
 * chosen, else copying the command, which always can. See the matrix in CLAUDE.md (Sessions).
 */
export function sessionOptions(s: SessionSituation): { options: ChoiceOption<SessionAction>[]; initial: number } {
  const { paired } = s;
  const copy: ChoiceOption<SessionAction> = { id: "copy", label: "Copy the command", detail: s.command };
  const noTerminal = s.terminal ? undefined : NO_TERMINAL;
  let options: ChoiceOption<SessionAction>[];
  // Ids in the order they are preferred as the first selection.
  let preferred: SessionAction[];
  if (s.state === "current") {
    options = [
      { id: "stay", label: "Stay attached", detail: "nothing changes" },
      { id: "detach", label: "Detach the viewer", detail: "it stays open and follows the project's newest session" },
    ];
    preferred = ["stay"];
  } else if (s.state === "active") {
    const switchTo: ChoiceOption<SessionAction> = { id: "switch", label: "Switch to its tab", detail: "it runs in another Claude Code", disabled: noTerminal };
    const attach: ChoiceOption<SessionAction> = paired
      ? { id: "attach", label: "Attach the viewer there", detail: "it stays here; this Claude Code is left without one", disabled: s.attachBlocked }
      : { id: "attach", label: "Attach the viewer", detail: "it stays here and follows that Claude Code", disabled: s.attachBlocked };
    options = paired ? [switchTo, attach] : [attach, switchTo];
    preferred = paired ? ["switch"] : ["attach", "switch"];
  } else {
    const gone = s.folderMissing ? "its folder is gone" : undefined;
    const window: ChoiceOption<SessionAction> = paired
      ? { id: "window", label: "Continue it in a new window", detail: "claude --resume in a new terminal window", disabled: gone ?? noTerminal }
      : { id: "window", label: "Only start it", detail: "in a new window; the viewer stays here, unpaired", disabled: gone ?? noTerminal };
    const windowAttach: ChoiceOption<SessionAction> = paired
      ? { id: "window-attach", label: "New window and attach", detail: "the viewer moves next to it", disabled: gone ?? noTerminal }
      : { id: "window-attach", label: "Start it and attach the viewer", detail: "in a new window; the viewer moves next to it", disabled: gone ?? noTerminal };
    if (paired) {
      const how = paired.method === "keys" ? "/resume is typed in" : "/resume is copied for you to paste";
      const here: ChoiceOption<SessionAction> = {
        id: "here",
        label: "Continue it here",
        detail: paired.empty ? `in this Claude Code, which has no prompt yet: ${how}` : `in this Claude Code, which leaves its session: ${how}`,
        disabled: gone ?? (s.otherFolder !== undefined ? `ran in ${s.otherFolder}, not in this folder` : paired.activity ? BUSY[paired.activity] : undefined),
      };
      options = [here, window, windowAttach];
      preferred = paired.empty ? ["here", "window"] : ["window"];
    } else {
      options = [windowAttach, window];
      preferred = ["window-attach", "window"];
    }
  }
  const into = s.here ? ` into ${s.here}` : "";
  if (s.state === "inactive" && s.movable !== undefined) {
    options.unshift({ id: "move", label: "Move it here", detail: `from ${s.movable}${into}` });
    preferred = ["move"];
  }
  const marked = s.marked ?? 0;
  options.push(
    { id: "rename", label: "Rename it", detail: "a new title, as /rename gives it", disabled: s.state === "inactive" ? undefined : RUNS },
    marked > 0
      ? { id: "export", label: `Export ${marked} marked session${marked === 1 ? "" : "s"}`, detail: "into a zip archive in the downloads folder" }
      : { id: "export", label: "Export it", detail: "into a zip archive in the downloads folder" },
    { id: "import", label: "Import sessions…", detail: `from a cco-session-export zip${into}` },
    copy,
  );
  const first = preferred.map((id) => options.findIndex((o) => o.id === id && !o.disabled)).find((i) => i >= 0);
  return { options, initial: first ?? options.indexOf(copy) };
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
    here: "resume here",
    window: s.paired ? "new window" : "start",
    "window-attach": s.paired ? "new window + attach" : "start + attach",
    move: "move here",
    rename: "rename",
    export: "export",
    import: "import",
    copy: "copy",
  };
  return `↵ ${LABELS[options[initial]!.id]}`;
}
