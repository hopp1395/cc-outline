import type { Turn } from "../transcript/parse.js";
import type { SessionActivity } from "../transcript/trash.js";
import { L } from "../i18n/index.js";

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
 * - `observe`: open an observer of it (the chat only, read-only, live) in a new window; `observe-front`: bring the
 *   one opened last to the front.
 * - `copy`: copy the command that continues it.
 */
export type SessionAction = "stay" | "detach" | "switch" | "attach" | "here" | "window" | "window-attach" | "move" | "rename" | "export" | "import" | "account" | "observe" | "observe-front" | "copy";

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
  /** How many observers of it run (◎). */
  observers?: number;
  /** The command `copy` copies. */
  command: string;
}

/** A session without a prompt yet: no turns, or only the /clear it began with. */
export function isEmptySession(turns: Turn[]): boolean {
  return turns.every((t, i) => i === 0 && /^\/clear(\s|$)/.test(t.prompt));
}

const BUSY = (activity: SessionActivity): string | undefined => (activity === "busy" ? L().resume.busy : activity === "waiting" ? L().resume.waiting : undefined);

/** Why the options that work on this account's folder cannot be chosen for another account's session. */
export const OWN_ONLY = () => L().resume.ownOnly;

/**
 * The options Enter offers for a session and the one selected at first: the preferred one that can be
 * chosen, else copying the command, which always can. See the matrix in CLAUDE.md (Sessions).
 */
export function sessionOptions(s: SessionSituation): { options: ChoiceOption<SessionAction>[]; initial: number } {
  const { paired } = s;
  const t = L().resume;
  const own = s.foreign ? t.ownOnly : undefined;
  const copy: ChoiceOption<SessionAction> = { id: "copy", label: t.copy, detail: s.command };
  const noTerminal = s.terminal ? undefined : t.noTerminal;
  let options: ChoiceOption<SessionAction>[];
  // Ids in the order they are preferred as the first selection.
  let preferred: SessionAction[];
  if (s.state === "current") {
    options = [
      { id: "stay", label: t.stay, detail: t.stayDetail },
      { id: "detach", label: t.detach, detail: t.detachDetail },
    ];
    preferred = ["stay"];
  } else if (s.state === "active") {
    const switchTo: ChoiceOption<SessionAction> = { id: "switch", label: t.switchTo, detail: t.switchDetail, disabled: noTerminal };
    const attach: ChoiceOption<SessionAction> = paired
      ? { id: "attach", label: t.attachThere, detail: t.attachThereDetail, disabled: own ?? s.attachBlocked }
      : { id: "attach", label: t.attach, detail: t.attachDetail, disabled: own ?? s.attachBlocked };
    options = paired ? [switchTo, attach] : [attach, switchTo];
    preferred = paired ? ["switch"] : ["attach", "switch"];
  } else {
    const gone = s.folderMissing ? t.folderGone : undefined;
    const as = s.account ? t.as(s.account) : "";
    const window: ChoiceOption<SessionAction> = {
      id: "window",
      label: t.window,
      detail: paired || s.foreign ? `claude --resume${as}` : `claude --resume${as}${t.unpaired}`,
      disabled: gone ?? noTerminal,
    };
    const windowAttach: ChoiceOption<SessionAction> = {
      id: "window-attach",
      label: t.windowAttach,
      detail: t.windowAttachDetail,
      disabled: own ?? gone ?? noTerminal,
    };
    if (s.foreign) {
      // /resume in this viewer's Claude Code cannot reach another account's session.
      options = [{ id: "here", label: t.here, detail: "", disabled: t.ownOnly }, window, ...(paired ? [] : [windowAttach])];
      preferred = ["window"];
    } else if (paired) {
      const how = paired.method === "keys" ? t.typed : t.copied;
      const here: ChoiceOption<SessionAction> = {
        id: "here",
        label: t.here,
        detail: paired.empty ? t.hereEmpty(how) : t.hereLeaves(how),
        disabled: gone ?? (s.otherFolder !== undefined ? t.otherFolder(s.otherFolder) : paired.activity ? BUSY(paired.activity) : undefined),
      };
      options = [here, window];
      preferred = paired.empty ? ["here", "window"] : ["window"];
    } else {
      options = [windowAttach, window];
      preferred = ["window-attach", "window"];
    }
  }
  const into = s.here ? t.into(s.here) : "";
  if (s.state === "inactive" && s.movable !== undefined) {
    options.unshift({ id: "move", label: t.move, detail: t.moveFrom(s.movable, into), disabled: own });
    if (!own) preferred = ["move"];
  }
  const marked = s.marked ?? 0;
  // Only offered with a second account signed in on this machine.
  const accounts = s.accounts ?? [];
  if (accounts.length > 0)
    options.push({
      id: "account",
      label: accounts.length === 1 ? t.inAccount(accounts[0]) : t.inAnother,
      detail: accounts.length === 1 ? t.copyOne : t.copyOf(accounts.length),
      disabled: own ?? (s.folderMissing ? t.folderGone : undefined),
    });
  options.push(...observeOptions(s.observers ?? 0, s.terminal));
  options.push(
    { id: "rename", label: t.rename, detail: t.renameDetail, disabled: own ?? (s.state === "inactive" ? undefined : t.runs) },
    marked > 0 && !own
      ? { id: "export", label: t.exportMarked(marked), detail: t.exportDetail }
      : { id: "export", label: t.export, detail: t.exportDetail, disabled: own },
    { id: "import", label: t.import, detail: t.importDetail(into), disabled: own },
    copy,
  );
  // When nothing else can be chosen (folder gone, another account's without a terminal), observing it can.
  const first = [...preferred, "observe"].map((id) => options.findIndex((o) => o.id === id && !o.disabled)).find((i) => i >= 0);
  return { options, initial: first ?? options.indexOf(copy) };
}

/**
 * Observing a session (also a remote one): another window each time, and bringing the one opened last to the front
 * while `observers` run. Without a terminal to open a window in, it copies the command; it can always be chosen.
 */
export function observeOptions(observers: number, terminal: boolean): ChoiceOption<"observe" | "observe-front">[] {
  const t = L().resume;
  return [
    {
      id: "observe",
      label: observers > 0 ? t.observeAnother : t.observeOwn,
      detail: terminal ? t.observeDetail : t.observeCopy,
    },
    ...(observers > 0
      ? [
          {
            id: "observe-front" as const,
            label: t.front,
            detail: observers === 1 ? t.frontOne : t.frontLast(observers),
            disabled: terminal ? undefined : t.noTerminal,
          },
        ]
      : []),
  ];
}

/** What the help line says Enter does: the action selected at first, or for the viewer's own session that it can detach. */
export function enterLabel(s: SessionSituation): string {
  if (s.state === "current") return L().resume.detachEnter;
  const { options, initial } = sessionOptions(s);
  return `↵ ${L().resume.labels[options[initial]!.id]}`;
}
