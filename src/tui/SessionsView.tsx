import { Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { displayPath, formatDuration, insideProject, lastActive, SessionIndex, type SessionSummary } from "../transcript/sessions.js";
import {
  deleteBlocker,
  emptyTrash,
  listTrash,
  purgeSession,
  restoreSession,
  runningSessionIds,
  runningSessions,
  trashSession,
  type RunningSession,
  type SessionActivity,
  type TrashEntry,
} from "../transcript/trash.js";
import { detectTerminal, resumeInNewWindow, resumeShellCommand } from "../open.js";
import { downloadsDir, EXPORT_NAME, exportSessions, freeName, importArchive, importSummary, newestExport, readExportOptions, saveExportOptions, type ExportProgress, type ExportResult } from "../export/archive.js";
import { moveSession } from "../export/move.js";
import { EXPORT_FORMATS, type ExportOptions } from "../export/session.js";
import { ExportDialog } from "./ExportDialog.js";
import { ImportDialog } from "./ImportDialog.js";
import { useProgress, useProgressOpen, type Progress } from "./ProgressDialog.js";
import { nextScope, scopeAccounts, scopeAllProjects, type Placement, type SessionsScope } from "../settings.js";
import { focusClaudePane, prepareConsoleInput, resumeHereMethod, resumeInClaude, resumeSlashCommand, switchToSession, type ConsoleTyper } from "../switchSession.js";
import { runningViewer, type PairTarget } from "../viewer.js";
import { otherAccounts } from "../accountContinue.js";
import { barColorOfAccount, type Account, type AccountColorName } from "../account.js";
import { pluginState } from "../accountSetup.js";
import { readTransfers, type Transfer } from "../transfers.js";
import { useAccountState } from "./useAccount.js";
import { useAccountFlow } from "./useAccountFlow.js";
import { countHead, fg, plural, sessionHead, sessionTitle, span, tilde, type HeadState } from "./sessionHead.js";
import { ChoiceDialog, type Choice } from "./ChoiceDialog.js";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog.js";
import { RenameDialog } from "./RenameDialog.js";
import { enterLabel, OWN_ONLY, sessionOptions, type SessionAction, type SessionSituation } from "./resumeChoice.js";
import { dayOf, linesByDay } from "./days.js";
import { formatMs, type AgentStatus, type PlanStatus } from "../transcript/parse.js";
import { doubleClicks } from "./openKey.js";
import { useFocused } from "./focus.js";
import { useClipboard } from "./useClipboard.js";
import {
  AreaContext,
  bold,
  dim,
  handleNavigation,
  List,
  markFooter,
  markKeys,
  previewHeader,
  Screen,
  EntryText,
  orderedNav,
  Star,
  truncate,
  wrapPath,
  type Layout,
} from "./layout.js";
import { planTitle } from "./PlanView.js";
import { bodyHeightBelow, centredBadge, fitHeader, Preview } from "./Preview.js";
import { haystack, type FilterText } from "../filter.js";
import { useFavorites } from "./useFavorites.js";
import { useOnReload, useReload } from "./reload.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { useSetting } from "./useSetting.js";
import { inClaudeDir, projectSlug } from "../transcript/locate.js";
import { renameSession } from "../transcript/rename.js";
import { isLoadMore, LOAD_MORE, LoadMoreRow, loadMoreLines, showsLoadMore, useListRange, type LoadMore } from "./loadMore.js";
import { TIMING } from "../timing.js";

interface Props {
  cwd: string;
  /** Transcript of the session the other views show; marked as the active one. */
  activePath?: string;
  layout: Layout;
  /** The view is shown; sessions are only read while it is. */
  visible: boolean;
  /** The view takes keys. */
  active: boolean;
  /** Reports whether the trash is shown, so Esc leaves it instead of quitting. */
  onTrashOpen?: (open: boolean) => void;
  /** Reports whether a confirmation is open; the app then leaves all keys to it. */
  onModal?: (open: boolean) => void;
  /** The filter dialog opened or closed. */
  onTyping?: (typing: boolean) => void;
  /**
   * Attaches the viewer to a running Claude Code process, leaving the one it belongs to, if any.
   * False if a viewer runs for that process already.
   */
  onPair?: (target: PairTarget) => boolean;
  /**
   * The Claude Code process the viewer belongs to: Enter on its session offers to detach, on a session
   * that runs nowhere to continue it there. `empty`: its session has no prompt yet. `placement`: where
   * the viewer runs.
   */
  paired?: { claudePid: number; empty: boolean; placement?: Placement };
  /**
   * The viewer started a Claude Code for a session and it runs now: the viewer attaches to it and moves
   * next to it, `where` it runs (`resumeForPairing`).
   */
  onPairStarted?: (target: PairTarget, where: string) => void;
  /** Detaches the viewer from its Claude Code; it then follows the project's newest session. */
  onDetach?: () => void;
  /**
   * Continuing the session in another account closes its Claude Code on purpose: while `hold` is true, the
   * viewer stays open when the Claude Code it belongs to ends, to move next to the new one.
   */
  onHoldOpen?: (hold: boolean) => void;
  /** /cco:account: asks which account to continue the active session in (`query` may name it); once per `at`. */
  accountRequest?: { at: number; query?: string };
}

/** How often the sessions are re-read while the view is shown; only changed files are parsed again. */
const REFRESH_MS = 3000;
export { PAIR_TIMEOUT_MS, pairingProgress } from "./useAccountFlow.js";

const STATUS_ICON: Record<PlanStatus, string> = {
  draft: "\u001b[36m✎\u001b[39m",
  approved: "\u001b[32m✓\u001b[39m",
  rejected: "\u001b[31m✗\u001b[39m",
  pending: "\u001b[33m●\u001b[39m",
};
const green = (s: string) => `\u001b[32m${s}\u001b[39m`;
const red = (s: string) => `\u001b[31m${s}\u001b[39m`;
const yellow = (s: string) => `\u001b[33m${s}\u001b[39m`;
const magenta = (s: string) => `\u001b[35m${s}\u001b[39m`;
const heading = (s: string) => `\u001b[1;36m${s}\u001b[22;39m`;

const pad = (n: number) => String(n).padStart(2, "0");
function time(ts?: string): string {
  if (!ts) return "     ";
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** "09-26 22:48". */
function dateTime(ts?: string): string {
  if (!ts) return "           ";
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time(ts)}`;
}


/** Whether `sessionTitle` falls back to a prompt, since the session has no /rename title. */
const titleIsPrompt = (s: SessionSummary) => s.title === undefined && s.prompts.length > 0;

/** Shell command that continues the session in Claude Code; for another account's, under its config folder. */
export function resumeCommand(s: SessionSummary): string {
  return s.account ? resumeShellCommand(s.id, s.account) : `claude --resume ${s.id}`;
}

/**
 * What a session is known by in the list (selection, marks, scroll positions, running): its id, for another
 * account's the folder too, since a session continued there may keep its id.
 */
export const sessionKey = (s: Pick<SessionSummary, "id" | "account">) => (s.account ? `${s.account}|${s.id}` : s.id);

/** What `a` shows in the help line for each scope. */
const SCOPE_FOOTER: Record<SessionsScope, string> = {
  project: "a all",
  all: "a all",
  "project-accounts": "a accounts",
  "all-accounts": "a all · accounts",
};

/** The lines the preview's header has about the account of a session, while the list shows every account's. */
export function sessionAccountLines(account: Account | undefined, color: AccountColorName | "gray", own: boolean): string[] {
  if (!account) return [];
  const plugin = pluginState(account.dir);
  const status = plugin.installed ? (plugin.enabled ? green("✓ installed") : yellow("! installed, disabled")) : red("✗ not installed");
  return [
    `\u001b[${fg(color)}m▌\u001b[39m ${account.email}${account.organization ? ` (${account.organization})` : ""} · ${tilde(account.dir)}${own ? dim(" · this account") : ""}`,
    `  cco plugin ${status}`,
  ];
}

/** Status of a subagent in the overview, like the chat's agent blocks. */
const AGENT_ICON: Record<AgentStatus, string> = {
  running: yellow("⠿"),
  completed: green("✓"),
  failed: red("✗"),
  killed: red("■"),
};

/** Plans, agents, changed files and prompts of a session, as lines of `width` columns. */
export function sessionLines(s: SessionSummary, viewerCwd: string, width: number, separators = true): string[] {
  // Paths are shown relative to the folder the session ran in.
  const cwd = s.cwd ?? viewerCwd;
  const lines: string[] = [];
  // Over several days, each day starts with a separator; a single day is named by the header.
  const severalDays = separators && dayOf(s.start) !== dayOf(s.end ?? s.start);
  const timed = <T,>(items: T[], at: (item: T) => string | undefined, line: (item: T) => string) =>
    severalDays ? linesByDay(items, at, line, width) : items.map(line);
  const section = (title: string, count: number, body: string[]) => {
    if (lines.length) lines.push("");
    lines.push(heading(`${title} (${count})`));
    lines.push(...(count ? body : [dim("  none")]));
  };
  section(
    "Plans",
    s.plans.length,
    timed(s.plans, (p) => p.timestamp, (p) => `  ${STATUS_ICON[p.status]} ${dim(time(p.timestamp))} ${truncate(planTitle(p.text), width - 10)}`),
  );
  const agents = s.agents ?? [];
  if (agents.length > 0) {
    section(
      "Agents",
      agents.length,
      timed(agents, (a) => a.started, (a) => {
        const icon = AGENT_ICON[a.status];
        const took = a.durationMs !== undefined ? dim(` ${formatMs(a.durationMs)}`) : "";
        return `  ${icon} ${dim(time(a.started))} ${truncate(`${a.type ?? "agent"} · ${a.description}`, width - 20)}${took}`;
      }),
    );
  }
  section(
    "Changed files",
    s.files.length,
    // Project files first; files elsewhere (e.g. plan files, scratch scripts) dimmed after them.
    [...s.files.filter((f) => insideProject(f, cwd)), ...s.files.filter((f) => !insideProject(f, cwd))].flatMap((f) =>
      wrapPath(displayPath(f, cwd), width - 2).map((l) => `  ${insideProject(f, cwd) ? l : dim(l)}`),
    ),
  );
  section(
    "Prompts",
    s.prompts.length,
    timed(s.prompts, (p) => p.timestamp, (p) => `  ${dim(time(p.timestamp))} ${truncate(p.text, width - 8)}`),
  );
  return lines;
}

type State = "active" | "running" | "trash" | undefined;

/** What the header says a running session's Claude does; nothing while it is idle. */
const ACTIVITY_TEXT: Record<SessionActivity, string> = { busy: "working · ", waiting: "waiting for input · ", idle: "" };

/** Where a session went on in another account, or came from: one line each. */
export function transferLines(t: Transfer | undefined): string[] {
  if (!t) return [];
  const date = (at: number) => dateTime(new Date(at).toISOString());
  return [
    ...(t.from ? [magenta(`⇠ continued from ${t.from.email || tilde(t.from.dir)} (${t.from.id.slice(0, 8)}) · ${date(t.from.at)}`)] : []),
    ...(t.to ?? []).map((e) => magenta(`⇢ continued in ${e.email} as ${e.id.slice(0, 8)} · ${date(e.at)}`)),
  ];
}

function sessionHeader(
  s: SessionSummary,
  state: State,
  width: number,
  deletedAt?: number,
  activity?: SessionActivity,
  gone?: boolean,
  transfer?: Transfer,
  account: string[] = [],
): string[] {
  const when = [span(s.start, s.end), formatDuration(s.start, s.end), s.branch].filter(Boolean).join(" · ");
  const counts = [
    plural(s.prompts.length, "prompt"),
    plural(s.plans.length, "plan"),
    ...(s.agents?.length ? [plural(s.agents.length, "agent")] : []),
    plural(s.files.length, "changed file"),
  ];
  const last =
    state === "trash"
      ? red(`in the trash since ${dateTime(new Date(deletedAt ?? 0).toISOString())} · u restores it`)
      : `${state === "active" ? "active · " : state === "running" ? (s.account ? "running there · " : "running elsewhere · ") : ""}${activity ? ACTIVITY_TEXT[activity] : ""}${resumeCommand(s)}`;
  // A session Claude Code went on with under a new id is shown as one; it names the ids it continues.
  const continues = s.continues?.length ? [dim(`continues ${s.continues.map((id) => id.slice(0, 8)).join(", ")}`)] : [];
  return previewHeader(sessionTitle(s), width, {
    marker: state === "active" || state === "running" ? (activity === "waiting" ? yellow : green)(state === "active" ? "● " : "▶ ") : "  ",
    style: bold,
    details: [when, counts.join(" · "), ...account, ...(s.cwd ? [gone ? red(`folder gone: ${tilde(s.cwd)}`) : `in ${tilde(s.cwd)}`] : []), ...continues, ...transferLines(transfer), last],
  });
}

/**
 * The sessions of the project (or, with `all`, of every project) and which of
 * them run in a Claude Code process, read while `visible` and refreshed every
 * few seconds; with `accounts` (their config folders) also those of the other
 * accounts, read after this one's. The first scan fills the list as it goes; `progress` counts the
 * transcripts read so far. `refresh` rescans at once. A reload of the view
 * (F5) reads every transcript again with new indexes; the list stays until
 * that scan is done. With `since`, only transcripts written since then are
 * read; when it changes (load more), the list also stays until the scan is done.
 */
function useSessions(cwd: string, visible: boolean, all: boolean, since: number | undefined, accounts: string[]) {
  // One index per config folder, "" for this viewer's own.
  const indexes = useRef(new Map<string, SessionIndex>());
  const reload = useReload();
  const loaded = useRef(reload.count);
  const sinceRef = useRef(since);
  const scanRef = useRef<() => Promise<void>>(async () => {});
  const [sessions, setSessions] = useState<SessionSummary[]>();
  // The last finished scan read every transcript (no `since`).
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const folders = accounts.join("\n");

  useEffect(() => {
    if (!visible) return;
    const fresh = reload.count !== loaded.current;
    loaded.current = reload.count;
    if (fresh) indexes.current = new Map();
    const extending = since !== sinceRef.current;
    sinceRef.current = since;
    // The indexes of the folders shown; those of accounts no longer shown are dropped.
    const current = ["", ...accounts].map((dir) => {
      let index = indexes.current.get(dir);
      if (!index) indexes.current.set(dir, (index = new SessionIndex(dir || undefined)));
      return index;
    });
    for (const dir of indexes.current.keys()) if (dir && !accounts.includes(dir)) indexes.current.delete(dir);
    let cancelled = false;
    let busy = false;
    let first = true;
    let reloading = fresh;
    // Also when the scan fails or stops early: F5 is refused while a reload runs.
    const finish = () => {
      if (!reloading) return;
      reloading = false;
      reload.done();
    };
    const scan = async () => {
      if (busy) return;
      busy = true;
      try {
        const found: SessionSummary[] = [];
        for (const index of current) {
          const result = await index.scan(all ? undefined : cwd, (partial, done, total) => {
            // Only the first scan shows partial lists; later ones just update the finished list.
            // A reload keeps the list and shows only the progress.
            if (cancelled || !first) return;
            if (!reloading && !extending) setSessions(byLastActive([...found, ...partial]));
            setProgress({ done, total });
          }, since);
          if (cancelled) return;
          found.push(...result);
        }
        first = false;
        setSessions(current.length > 1 ? byLastActive(found) : found);
        setComplete(since === undefined);
        setProgress(undefined);
      } finally {
        busy = false;
        finish();
      }
    };
    scanRef.current = scan;
    void scan();
    const timer = setInterval(() => void scan(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      finish();
    };
  }, [cwd, visible, all, reload.count, since, folders]);

  return { sessions, progress, complete, refresh: () => void scanRef.current() };
}

/** The sessions of several accounts in one list, oldest first, like each index gives them. */
const byLastActive = (sessions: SessionSummary[]) => sessions.sort((a, b) => (lastActive(a) ?? "").localeCompare(lastActive(b) ?? ""));

const sameRunning = (a: Map<string, RunningSession>, b: Map<string, RunningSession>) =>
  a.size === b.size &&
  [...a].every(([id, r]) => {
    const o = b.get(id);
    return o !== undefined && o.pid === r.pid && o.activity === r.activity && o.name === r.name;
  });

/**
 * The sessions running in a Claude Code process and what it does in each, by `sessionKey`, read every second while
 * `visible`, also in the config folders of the other `accounts` shown; the map only changes when one of them does,
 * so the memoized header stays.
 */
function useRunning(visible: boolean, accounts: string[]): Map<string, RunningSession> {
  const [running, setRunning] = useState<Map<string, RunningSession>>(() => new Map());
  const folders = accounts.join("\n");
  useEffect(() => {
    if (!visible) return;
    const read = () => {
      const next = runningSessions();
      for (const dir of accounts) for (const [id, r] of inClaudeDir(dir, runningSessions)) next.set(sessionKey({ id, account: dir }), r);
      setRunning((prev) => (sameRunning(prev, next) ? prev : next));
    };
    read();
    const timer = setInterval(read, TIMING.activityPoll);
    return () => clearInterval(timer);
  }, [visible, folders]);
  return running;
}

/**
 * The marker of the active (`●`) or a running (`▶`) session in the list: yellow while its Claude waits
 * for the user, green otherwise, turning bright and dim while it works. Owns its timer so only it
 * re-renders; the phase comes from the clock, so all working sessions blink together.
 */
function SessionMarker({ symbol, activity }: { symbol: string; activity?: SessionActivity }) {
  const busy = activity === "busy";
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(() => {
        setTick((n) => n + 1);
        next();
      }, TIMING.blink - (Date.now() % TIMING.blink));
    };
    next();
    return () => clearTimeout(timer);
  }, [busy]);
  const dimmed = busy && Math.floor(Date.now() / TIMING.blink) % 2 === 1;
  return (
    <Text color={activity === "waiting" ? "yellow" : "green"} dimColor={dimmed}>
      {symbol}
    </Text>
  );
}

/** Short name of the project a session belongs to: its folder name. */
function projectName(s: SessionSummary): string {
  return s.cwd ? basename(s.cwd) : basename(dirname(s.path));
}

/** What a session is found by in the filter: in the list its title and project; in the details where and on which branch it ran, its prompts, files, plans and agents. */
function sessionText(s: SessionSummary, gone: boolean, email?: string): FilterText {
  return {
    list: haystack([sessionTitle(s), projectName(s), email]),
    details: haystack([
      s.cwd,
      gone ? "folder gone" : undefined,
      s.branch,
      s.id,
      ...(s.continues ?? []),
      ...s.prompts.map((p) => p.text),
      ...s.files,
      ...s.plans.map((p) => planTitle(p.text)),
      ...(s.agents ?? []).map((a) => a.description),
    ]),
  };
}

/** The entry of an empty list that imports sessions. */
const IMPORT_ENTRY = { importSessions: true } as const;
type ImportEntry = typeof IMPORT_ENTRY;
const isImport = (e: unknown): e is ImportEntry => e === IMPORT_ENTRY;

/** An entry of the list: a session, load more at its oldest end, or import while there is no session. */
type Entry = SessionSummary | LoadMore | ImportEntry;
const LOAD_MORE_ID = "load-more";
const IMPORT_ID = "import";
const isSession = (e: Entry | undefined): e is SessionSummary => e !== undefined && !isLoadMore(e) && !isImport(e);
const entryId = (e: Entry) => (isLoadMore(e) ? LOAD_MORE_ID : isImport(e) ? IMPORT_ID : sessionKey(e));

/** The row of the import entry, a badge like load more. */
function ImportRow() {
  const area = useContext(AreaContext);
  return <Text>{centredBadge("⤓ import sessions…", area.width || 40)}</Text>;
}

/** The export's progress dialog: the step of the session being exported; the archive, or why it failed. */
export function exportProgress(count: number, state: { progress?: ExportProgress; title?: string } | { result: ExportResult } | { error: Error }): Progress {
  const title = `Export ${plural(count, "session")}`;
  if ("result" in state)
    return { title, status: "done", text: `Exported ${plural(state.result.sessions, "session")}`, lines: [basename(state.result.file), `in ${tilde(dirname(state.result.file))}`] };
  if ("error" in state) return { title, status: "failed", text: "Nothing was written", lines: [state.error.message] };
  const { progress: p, title: session } = state;
  if (!p) return { title, status: "running", text: "Exporting" };
  const steps: string[] = ["reading", ...EXPORT_FORMATS];
  return {
    title,
    status: "running",
    text: "Exporting",
    step: { label: p.step, at: steps.indexOf(p.step) + 1, of: steps.length },
    detail: p.sessions > 1 ? `session ${p.session} of ${p.sessions}${session ? `: ${session}` : ""}` : session,
  };
}

export function SessionsView({ cwd, activePath, layout, visible, active, onTrashOpen, onModal, onTyping, onPair, paired, onPairStarted, onDetach, onHoldOpen, accountRequest }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const [isDoubleClick] = useState(() => doubleClicks());
  const copy = useClipboard();
  const [scope, setScope] = useSetting("sessionsScope");
  const all = scopeAllProjects(scope);
  const [separators] = useSetting("dateSeparators");
  const [pinnedSessions] = useSetting("pinnedSessions");
  const [accountColor] = useSetting("accountColor");
  const range = useListRange("sessionsRange");
  // The other accounts signed in here: a session can continue in one of them, and the list may show theirs.
  const accountState = useAccountState();
  const others = otherAccounts(accountState.accounts);
  const ownAccount = accountState.accounts.find((a) => otherAccounts([a], accountState.own).length === 0);
  // With the other accounts, every row gets a bar in its account's colour and the header names the account.
  const withAccounts = scopeAccounts(scope) && others.length > 0;
  const foreignKey = withAccounts ? others.map((a) => a.dir).join("\n") : "";
  const foreign = useMemo(() => (foreignKey ? foreignKey.split("\n") : []), [foreignKey]);
  const { sessions: read, progress, complete, refresh } = useSessions(cwd, visible, all, range.since, foreign);
  const running = useRunning(visible, foreign);
  const activeId = activePath ? basename(activePath, ".jsonl") : undefined;
  /** The viewer's own session; another account's never is, even under the same id. */
  const isActive = (s: SessionSummary) => !s.account && s.id === activeId;
  const accountOf = (s: SessionSummary): Account | undefined => (s.account ? others.find((a) => a.dir === s.account) : ownAccount);
  const barColor = (s: SessionSummary): AccountColorName | "gray" => {
    const account = accountOf(s);
    return account ? barColorOfAccount(account, accountState, accountColor) : "gray";
  };
  // The sessions last worked in during the range (see lastActive); the active and running ones also when that was before it.
  const sessions = useMemo(() => {
    const since = range.since;
    if (!read || since === undefined) return read;
    return read.filter((s) => {
      const at = lastActive(s);
      return !at || Date.parse(at) >= since || isActive(s) || running.has(sessionKey(s));
    });
  }, [read, range.since, activeId, running]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  // The session moved to the trash last, for u (undo) in the list.
  const [lastTrashed, setLastTrashed] = useState<SessionSummary>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  // Enter on a session that runs nowhere: where to continue it; then, for pairing, the wait for its Claude Code.
  const [choice, setChoice] = useState<Choice>();
  // The session being renamed, while its dialog is open.
  const [renaming, setRenaming] = useState<SessionSummary>();
  // Export (Enter): the sessions to export, while the form is open; import: its dialog; then the run of either.
  const [exporting, setExporting] = useState<{ sessions: SessionSummary[]; opts: ExportOptions; lines: string[] }>();
  // The archive the import dialog proposes ("" for none), while it is open.
  const [importFrom, setImportFrom] = useState<string>();
  const [run, setRun] = useState<Progress>();
  // Continuing in another account, and the wait for a Claude Code the viewer started to attach to.
  const flow = useAccountFlow({
    layout,
    claudePid: paired?.claudePid,
    onPairStarted,
    onHoldOpen,
    notify: (message) => notify(message),
    onCopied: () => refresh(),
  });
  // The app's progress dialog shows the export, the import or the wait for a Claude Code to attach to.
  const progressOpen = useProgressOpen();
  const dialogOpen =
    confirmation !== undefined || choice !== undefined || renaming !== undefined || exporting !== undefined || importFrom !== undefined || run !== undefined || flow.open || progressOpen;
  // Selection and each session's scroll position survive switching sessions and restarting the viewer.
  const positions = usePositions(cwd, "sessions");
  // Selected by id, so the selection stays when sessions are added; none yet means the newest.
  const [selectedId, setSelectedId] = useState<string | undefined>(positions.selected);
  const storedId = useRef(positions.selected);
  const restoredShown = useRef(false);
  const [trashSelectedId, setTrashSelectedId] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const favorites = useFavorites(cwd, "sessions");
  // Sessions continued in another account or from one, per account and project folder; read again with each scan.
  const transfers = useMemo(() => new Map<string, Record<string, Transfer>>(), [sessions]);
  const transferOf = (s: SessionSummary): Transfer | undefined => {
    const dir = s.cwd ?? cwd;
    const key = `${s.account ?? ""}|${dir}`;
    let found = transfers.get(key);
    if (!found) transfers.set(key, (found = s.account ? inClaudeDir(s.account, () => readTransfers(dir)) : readTransfers(dir)));
    return [s.id, ...(s.continues ?? [])].map((id) => found[id]).find(Boolean);
  };
  // Whether a session's folder is gone: looked up once per folder while the view runs, again after F5.
  const folders = useRef(new Map<string, boolean>());
  const folderGone = (s: SessionSummary) => {
    if (!s.cwd) return false;
    let gone = folders.current.get(s.cwd);
    if (gone === undefined) folders.current.set(s.cwd, (gone = !existsSync(s.cwd)));
    return gone;
  };

  // The sessions are kept oldest first and shown newest first, so load more (the oldest end) comes last;
  // the trash is kept and shown with the latest deletion first.
  const reversed = !trashOpen;
  const more = showsLoadMore(range, complete);
  // Without any session, an entry to import some leads the list (it is kept oldest first and shown reversed).
  const sessionList: Entry[] = useMemo(
    () => [...(more && sessions ? [LOAD_MORE] : []), ...(sessions ?? []), ...(sessions?.length === 0 ? [IMPORT_ENTRY] : [])],
    [more, sessions],
  );
  const list: Entry[] = trashOpen ? trash.map((e) => e.summary) : sessionList;
  // The time the list is sorted by and shown with: the last question to Claude (lastActive), in the trash the deletion.
  const deletedAt = new Map(trash.map((e) => [e.id, e.deletedAt]));
  const listedAt = (s: Entry) => {
    if (!isSession(s)) return undefined;
    const deleted = trashOpen ? deletedAt.get(s.id) : undefined;
    return deleted !== undefined ? new Date(deleted).toISOString() : lastActive(s);
  };
  const markedCount = (sessions ?? []).filter((s) => favorites.isMarked(sessionKey(s))).length;
  const currentId = trashOpen ? trashSelectedId : selectedId;
  const setCurrentId = trashOpen ? setTrashSelectedId : setSelectedId;

  const found = list.findIndex((s) => entryId(s) === currentId);
  // The list starts at the newest session (last); the trash at the latest deletion (first).
  const index = found >= 0 ? found : trashOpen ? 0 : list.length - 1;
  // Only the sessions are filtered, not the trash; their filter stays while the trash is open.
  const sessionFound = sessionList.findIndex((s) => entryId(s) === selectedId);
  // The session selected last time, once a scan has found it: the list centres it.
  if (!restoredShown.current && sessionFound >= 0 && selectedId === storedId.current) restoredShown.current = true;
  const filter = useListFilter({
    items: sessionList,
    text: (e) => (isSession(e) ? sessionText(e, folderGone(e), withAccounts ? accountOf(e)?.email : undefined) : { list: "", details: "" }),
    selected: sessionFound >= 0 ? sessionFound : sessionList.length - 1,
    select: (i) => select(i),
    reversed: true,
    layout,
    enabled: !trashOpen,
    onTyping,
    keep: (e) => !isSession(e),
    marked: (e) => isSession(e) && favorites.isMarked(sessionKey(e)),
    pin: pinnedSessions ? (e) => isSession(e) && (isActive(e) || running.has(sessionKey(e))) : undefined,
    restoreCopy: positions.pinned ? (e) => isSession(e) && sessionKey(e) === storedId.current : undefined,
  });
  // Only a selection made (or restored) counts; the default "newest" of a half-read list is not stored.
  useEffect(() => {
    if (selectedId !== LOAD_MORE_ID && selectedId !== IMPORT_ID) positions.select(selectedId, undefined, filter.copySelected);
  }, [selectedId, filter.copySelected]);
  const picked = filter.none ? undefined : list[index];
  const onLoadMore = isLoadMore(picked);
  const onImport = isImport(picked);
  const session = isSession(picked) ? picked : undefined;
  // The oldest session before load more was clicked: the one read next to it gets the selection.
  const loadedAfter = useRef<string | undefined>(undefined);
  const loadMore = () => {
    if (range.requested) return;
    loadedAfter.current = sessions?.[0] && sessionKey(sessions[0]);
    range.loadAll();
  };
  // Once the whole history is read and the entry is gone, the selection moves to the newest of the sessions read now.
  useEffect(() => {
    if (more || selectedId !== LOAD_MORE_ID || !sessions) return;
    const at = sessions.findIndex((s) => sessionKey(s) === loadedAfter.current);
    const next = sessions[at >= 0 ? Math.max(0, at - 1) : sessions.length - 1];
    setSelectedId(next && sessionKey(next));
  }, [more, sessions]);
  const entry = trashOpen ? trash[index] : undefined;
  const stateOf = (s: SessionSummary): State =>
    trashOpen ? "trash" : isActive(s) ? "active" : running.has(sessionKey(s)) ? "running" : undefined;

  const header = useMemo(() => {
    if (!session) return [];
    const state = stateOf(session);
    const activity = state === "active" || state === "running" ? running.get(sessionKey(session))?.activity : undefined;
    const account = withAccounts && !trashOpen ? sessionAccountLines(accountOf(session), barColor(session), !session.account) : [];
    return fitHeader(
      sessionHeader(session, state, previewWidth, entry?.deletedAt, activity, folderGone(session), trashOpen ? undefined : transferOf(session), account),
      bodyHeight,
    );
  }, [session, activeId, running, trashOpen, entry, previewWidth, bodyHeight, transfers, withAccounts, accountState, accountColor]);
  const lines = useMemo(
    () => (session ? sessionLines(session, cwd, previewWidth, separators) : []),
    [session, cwd, previewWidth, separators],
  );
  const viewport = bodyHeightBelow(header, bodyHeight);
  const scroll = positions.scroll(session && sessionKey(session), lines.length, viewport);

  useEffect(() => onModal?.(dialogOpen), [dialogOpen]);
  useEffect(() => onTrashOpen?.(trashOpen), [trashOpen]);

  const select = (next: number) => {
    const target = list[Math.max(0, Math.min(list.length - 1, next))];
    if (!target || target === picked) return;
    setCurrentId(entryId(target));
  };
  /** After removing the selected entry: select its neighbour, a session rather than load more. */
  const selectNeighbour = () => {
    const next = [list[index + 1], list[index - 1]].find(isSession);
    setCurrentId(next && sessionKey(next));
  };

  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const notify = (msg: string) => {
    setFlash(msg);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(undefined), 3000);
  };
  /** Runs a trash operation, reporting a failure instead of throwing. */
  const attempt = (action: () => void, done: string) => {
    try {
      action();
      notify(done);
    } catch (err) {
      notify(`failed: ${(err as Error).message}`);
    }
    setTrash(listTrash(trashScope));
    refresh();
  };

  const toggleTrash = (open: boolean) => {
    if (open) setTrash(listTrash(trashScope));
    setTrashOpen(open);
  };
  // F5 in the trash reads it again too, and the folders are looked up again.
  useOnReload(() => {
    folders.current.clear();
    if (trashOpen) setTrash(listTrash(trashScope));
  });

  /**
   * Where `s` stands for Enter: the viewer's own session (paired viewers only), running in a Claude Code
   * (the one it runs in, `claude`), or nowhere; and what keeps an action from being chosen.
   */
  const situationOf = (s: SessionSummary) => {
    const dir = s.cwd ?? cwd;
    const claude = running.get(sessionKey(s));
    const own = paired && [...running.values()].find((r) => r.pid === paired.claudePid);
    const state: SessionSituation["state"] = paired && isActive(s) ? "current" : claude ? "active" : "inactive";
    const folderMissing = state === "inactive" && !existsSync(dir);
    const situation: SessionSituation = {
      paired: paired && { empty: paired.empty, activity: own ? own.activity : undefined, method: resumeHereMethod() },
      state,
      attachBlocked: !onPair ? "this viewer cannot attach" : claude && runningViewer(dir, claude.pid) ? "it has a viewer of its own" : undefined,
      // /resume finds only the sessions of the project folder its Claude Code runs in, this viewer's.
      otherFolder: projectSlug(dir) === projectSlug(cwd) ? undefined : truncate(basename(dir), 20),
      folderMissing,
      movable: folderMissing && s.cwd && projectSlug(s.cwd) !== projectSlug(cwd) ? truncate(basename(s.cwd), 20) : undefined,
      here: truncate(basename(cwd), 20),
      marked: markedCount,
      accounts: others.map((a) => a.email),
      account: accountState.accounts.length >= 2 ? accountOf(s)?.email : undefined,
      foreign: s.account !== undefined,
      terminal: detectTerminal() !== undefined,
      // A session the Claude Code daemon runs is attached to, not resumed.
      command: claude?.kind === "bg" && claude.jobId ? `claude attach ${claude.jobId}` : resumeCommand(s),
    };
    return { situation, claude, dir };
  };

  /** The head every dialog about `s` starts with; where it stands as Enter sees it, unless `state` says. */
  const headFor = (s: SessionSummary, state?: HeadState) => {
    const dir = s.cwd ?? cwd;
    const stands: HeadState = state ?? (paired && isActive(s) ? "current" : running.has(sessionKey(s)) ? "active" : "inactive");
    return sessionHead(s, { accounts: accountState, accountColor }, { dir, gone: !existsSync(dir), state: stands });
  };

  /** Enter: asks what to do with the session (`sessionOptions`), with the usual choice selected. */
  const start = (s: SessionSummary) => {
    if (s.account && !accountOf(s)) return notify("its account is no longer signed in here");
    const { situation, claude, dir } = situationOf(s);
    const lines = headFor(s, situation.state);
    const { options, initial } = sessionOptions(situation);
    // On Windows, PowerShell takes a second or more to start: it does so while the dialog is open.
    const here = options.find((o) => o.id === "here");
    if (paired && here && !here.disabled && resumeHereMethod() === "keys" && detectTerminal() !== "tmux") typer.current = prepareConsoleInput(paired.claudePid);
    setChoice({
      title: "What to do with this session?",
      lines,
      options,
      initial,
      onChoose: (id: string) => {
        const prepared = takeTyper();
        if (id !== "here") prepared?.cancel();
        // Attaching to a new window then waits in the progress dialog.
        setChoice(undefined);
        act(id as SessionAction, s, dir, claude, situation.command, prepared);
      },
    });
  };

  const act = (id: SessionAction, s: SessionSummary, dir: string, claude: RunningSession | undefined, command: string, prepared?: ConsoleTyper) => {
    switch (id) {
      case "stay":
        return;
      case "detach":
        return onDetach?.();
      case "switch":
        if (!claude) return;
        notify("looking for its tab…");
        return void switchToSession(claude, s.title ? [s.title] : []).then(notify);
      case "attach":
        if (!claude) return;
        if (!onPair?.({ cwd: dir, claudePid: claude.pid, sessionId: s.id, transcript: s.path })) notify("another viewer attached to it first");
        return;
      case "here":
        return void (paired && continueHere(s.id, paired, prepared));
      case "window":
        // Another account's session continues under its config folder.
        notify(resumeInNewWindow(s.id, dir, truncate(sessionTitle(s), 30), "new", s.account));
        // Show it as running as soon as Claude Code registers it.
        setTimeout(refresh, 3000);
        return;
      case "window-attach":
        return void flow.startPairing(s, sessionTitle(s), dir);
      case "move":
        return askMove(s);
      case "rename":
        return setRenaming(s);
      case "export":
        return askExport(s);
      case "import":
        return askImport();
      case "account":
        return flow.askAccount(s, claude, dir);
      case "copy":
        return void copy(command).then(
          () => notify(`copied: ${command}`),
          (err: Error) => notify(`copy failed: ${err.message}`),
        );
    }
  };
  // The PowerShell started for "continue it here", until it is used or the dialog closes.
  const typer = useRef<ConsoleTyper>(undefined);
  const takeTyper = () => {
    const prepared = typer.current;
    typer.current = undefined;
    return prepared;
  };
  const closeChoice = () => {
    takeTyper()?.cancel();
    setChoice(undefined);
  };
  useEffect(() => () => takeTyper()?.cancel(), []);

  /** Writes the new title into the transcript the session continues in; the next scan shows it. */
  const rename = (s: SessionSummary, title: string) => {
    setRenaming(undefined);
    try {
      renameSession(s.path, s.id, title);
      notify(`renamed: ${title}`);
    } catch (err) {
      notify(`rename failed: ${(err as Error).message}`);
    }
    refresh();
  };

  /** Continues the session in the viewer's own Claude Code: types /resume into it, else copies it to paste there. */
  const continueHere = async (id: string, claude: NonNullable<Props["paired"]>, prepared?: ConsoleTyper) => {
    let failed: string | undefined;
    if (resumeHereMethod() === "keys") {
      notify("typing /resume in Claude Code…");
      const result = await resumeInClaude(claude.claudePid, id, prepared);
      if (result.typed) return notify(result.message);
      failed = result.message;
    }
    const command = resumeSlashCommand(id);
    await copy(command).then(
      () => notify(`${failed ? `${failed}; ` : ""}copied ${command}: paste it in Claude Code${focusClaudePane(claude.placement) ? "" : "'s prompt"} (Ctrl+V) and press Enter`),
      (err: Error) => notify(`copy failed: ${err.message}`),
    );
  };

  useProgress(
    run && {
      ...run,
      onClose: () => {
        setRun(undefined);
        run.onClose?.();
      },
    },
  );

  const askDelete = (s: SessionSummary) => {
    const blocker = deleteBlocker(s.id, activeId, runningSessionIds());
    if (blocker) return notify(blocker);
    setConfirmation({
      title: "Move this session to the trash?",
      lines: [...headFor(s), "", "You can restore it from the trash (T)."],
      onConfirm: () =>
        attempt(() => {
          trashSession(s, activeId);
          setLastTrashed(s);
          selectNeighbour();
        }, "moved to the trash · u undo · T trash"),
    });
  };
  /** The trash shows the same scope as the list: this project or all. */
  const trashScope = all ? undefined : projectSlug(cwd);
  const slugOf = (s: SessionSummary) => basename(dirname(s.path));
  const restore = (s: SessionSummary, after?: () => void) =>
    attempt(() => {
      restoreSession(slugOf(s), s.id);
      after?.();
      setLastTrashed(undefined);
    }, "restored");
  const askPurge = (s: SessionSummary) =>
    setConfirmation({
      title: "Delete this session for good?",
      lines: [
        ...headFor(s, { trash: dateTime(new Date(deletedAt.get(s.id) ?? 0).toISOString()) }),
        "",
        "Transcript, file history and subagent data are removed.",
        "This can't be undone.",
      ],
      danger: true,
      onConfirm: () =>
        attempt(() => {
          purgeSession(slugOf(s), s.id, cwd);
          selectNeighbour();
        }, "deleted for good"),
    });
  const askEmpty = () => {
    if (trash.length === 0) return;
    setConfirmation({
      title: "Empty the trash?",
      lines: [countHead(trash.length, "session", all ? "of all projects" : "of this project"), "", "They will be deleted for good.", "This can't be undone."],
      danger: true,
      onConfirm: () => attempt(() => void emptyTrash(trashScope, cwd), "trash emptied"),
    });
  };

  /** The marked sessions, else `s`, with the form for the options. */
  const askExport = (s: SessionSummary) => {
    // Only this account's sessions: another account's are not exported from here.
    const marked = (sessions ?? []).filter((m) => !m.account && favorites.isMarked(m.id));
    const targets = marked.length ? marked : [s];
    setExporting({ sessions: targets, opts: readExportOptions(), lines: exportLines(targets) });
  };
  const askImport = () => setImportFrom(newestExport() ?? "");
  /** Asks, then moves a session whose folder is gone into this project folder. */
  const askMove = (s: SessionSummary) =>
    setConfirmation({
      title: "Move this session here?",
      lines: [...headFor(s), "", truncate(`into ${tilde(cwd)}`, 56), "Its paths are rewritten; claude --resume continues it here."],
      onConfirm: () =>
        attempt(() => {
          moveSession(s, cwd);
          setSelectedId(s.id);
        }, "moved here"),
    });
  // /cco:account: the active session, once the scan has found it (or has finished without it).
  const handledRequest = useRef<number>(undefined);
  useEffect(() => {
    if (!accountRequest || handledRequest.current === accountRequest.at || !sessions || dialogOpen) return;
    const s = sessions.find(isActive);
    if (!s && progress) return;
    handledRequest.current = accountRequest.at;
    if (!s) return notify("no session here to continue in another account");
    setSelectedId(s.id);
    // Read now: the view may have just been shown, before its first look at the running sessions.
    flow.askAccount(s, runningSessions().get(s.id), situationOf(s).dir, accountRequest.query);
  }, [accountRequest, sessions, progress, dialogOpen]);

  const exportLines = (targets: SessionSummary[]) => {
    const file = freeName(downloadsDir(), EXPORT_NAME);
    const dir = tilde(dirname(file));
    const one = targets.length === 1 ? targets[0] : undefined;
    return [
      ...(one ? headFor(one) : [countHead(targets.length, "marked session", all ? "of all projects" : "of this project")]),
      "",
      `to ${basename(file)}`,
      // The end of the folder's path names it best.
      dir.length > 53 ? `in …${dir.slice(-52)}` : `in ${dir}`,
    ];
  };
  const runExport = (targets: SessionSummary[], opts: ExportOptions) => {
    saveExportOptions(opts);
    setExporting(undefined);
    const count = targets.length;
    setRun(exportProgress(count, {}));
    exportSessions(targets, opts, {
      viewerCwd: cwd,
      onProgress: (p) => setRun(exportProgress(count, { progress: p, title: truncate(sessionTitle(targets[p.session - 1]!), 40) })),
    }).then(
      (result) => setRun(exportProgress(count, { result })),
      (error: Error) => setRun(exportProgress(count, { error })),
    );
  };
  const runImport = (file: string) => {
    setImportFrom(undefined);
    setRun({ title: "Import", status: "running", text: "Importing", detail: tilde(file) });
    // A moment for the dialog to show; the import itself runs at once.
    setTimeout(() => {
      try {
        const result = importArchive(file, cwd);
        const lines = [
          ...result.imported.map((s) => `  ✓ ${s.title}${s.from ? ` (new id ${s.id.slice(0, 8)})` : ""}`),
          ...result.skipped.map((s) => `  – ${s.title}: ${s.reason}`),
        ].slice(0, 8);
        const summary = importSummary(result);
        setRun({ title: "Import", status: "done", text: summary[0]!.toUpperCase() + summary.slice(1), lines });
        // Written just now, the imported sessions are the newest: the first of them is selected.
        if (result.imported[0]) setSelectedId(result.imported[0].id);
        refresh();
      } catch (err) {
        setRun({ title: "Import", status: "failed", text: "Nothing was imported", lines: [(err as Error).message] });
      }
    }, 50);
  };

  useInput(
    (input, key) => {
      if (filter.handleKey(input, key)) return;
      if (input === "T") return toggleTrash(!trashOpen);
      if (input === "a") {
        const next = nextScope(scope);
        setScope(next);
        // The trash follows the scope right away; the list follows with the next scan.
        if (trashOpen) setTrash(listTrash(scopeAllProjects(next) ? undefined : projectSlug(cwd)));
        return;
      }
      if (trashOpen) {
        if (key.escape) return toggleTrash(false);
        if (input === "u" && session) return restore(session, selectNeighbour);
        if (input === "x" && session) return askPurge(session);
        if (input === "X") return askEmpty();
      } else {
        // Checked first: Shift+↑/↓ jump between marked sessions.
        const mark = markKeys(input, key);
        if (mark === "toggle") {
          if (!session) return;
          if (favorites.isMarked(sessionKey(session))) filter.unmarking(index);
          return favorites.toggle(sessionKey(session));
        }
        if (mark) {
          const target = filter.nextMark(mark);
          return target !== undefined && select(target);
        }
        if ((input === "d" || key.delete) && session) return session.account ? notify(OWN_ONLY) : askDelete(session);
        if (input === "u") {
          if (!lastTrashed) return notify("nothing to undo");
          const s = lastTrashed;
          return restore(s, () => setSelectedId(s.id));
        }
        if (key.return && onLoadMore) return loadMore();
        if (key.return && onImport) return askImport();
        if (key.return && session) return start(session);
        if (input === "c" && session) {
          const command = resumeCommand(session);
          return void copy(command).then(
            () => notify(`copied: ${command}`),
            (err: Error) => notify(`copy failed: ${err.message}`),
          );
        }
      }
      handleNavigation(input, key, {
        ...(trashOpen
          ? orderedNav(reversed, {
              select: (delta: number) => select(index + delta),
              first: () => select(0),
              last: () => select(list.length - 1),
            })
          : filter.nav),
        scroll,
        page: viewport - 2,
      });
    },
    { isActive: active && !dialogOpen && !filter.open },
  );

  let preview;
  if (trashOpen && !session) preview = <Text dimColor>The trash is empty.</Text>;
  else if (!sessions) preview = <Text dimColor>Reading sessions…</Text>;
  else if (filter.none) preview = <Text dimColor>No session matches the filter</Text>;
  else if (onLoadMore) preview = <Text dimColor>{loadMoreLines(range, "sessions", sessions.length, range.requested).join("\n")}</Text>;
  else if (onImport)
    preview = (
      <Text dimColor>
        {[
          all ? "No Claude Code sessions found." : `No Claude Code session found for ${cwd}.`,
          "",
          `Enter or a double click imports sessions from a cco-session-export zip archive into ${tilde(cwd)}.`,
        ].join("\n")}
      </Text>
    );
  else if (!session) preview = <Text dimColor>{all ? "No Claude Code sessions found" : `No Claude Code session found for ${cwd}`}</Text>;
  else
    preview = (
      <Preview
        header={header}
        lines={lines}
        scroll={scroll.scroll}
        width={previewWidth}
        height={bodyHeight}
        onWheel={(d) => scroll.by(d)}
        onLink={(url) => notify(`opened ${url}`)}
      />
    );

  const footer = trashOpen
    ? [
        { text: "↑↓ session", priority: 4 },
        { text: "PgUp/Dn scroll", priority: 1 },
        { text: "u restore", priority: 4 },
        { text: "x delete", priority: 3 },
        { text: "X empty", priority: 2 },
        { text: SCOPE_FOOTER[scope], on: scope !== "project", priority: 2 },
        { text: "T trash", on: true },
      ]
    : [
        { text: "↑↓ session", priority: 4 },
        { text: "PgUp/Dn scroll", priority: 1 },
        ...markFooter(favorites.isMarked(session && sessionKey(session)), markedCount),
        ...filter.footer,
        {
          text: onLoadMore
            ? "↵ load more"
            : onImport
              ? "↵ import"
              : session
                ? enterLabel(situationOf(session).situation)
                : "↵ start",
          priority: 3,
        },
        { text: "c copy resume", priority: 2 },
        { text: "d delete", priority: 2 },
        ...(lastTrashed ? [{ text: "u undo", priority: 3 }] : []),
        { text: SCOPE_FOOTER[scope], on: scope !== "project", priority: 2 },
        { text: "T trash", priority: 2 },
        { text: "1-6/tab view", priority: 1 },
      ];

  return (
    <>
      <Screen
        layout={layout}
        mode="sessions"
        status={
          <Text dimColor={!focused}>
            {trashOpen ? (
              <Text color="red">TRASH · {plural(trash.length, "session")}</Text>
            ) : sessions ? (
              `${filter.count(sessions.length)} ${sessions.length === 1 ? "session" : "sessions"}`
            ) : (
              "…"
            )}
            {progress && <Text color="yellow">{` · reading ${progress.done}/${progress.total}`}</Text>}
            {session && !progress && ` · ${scroll.position}`}
            {!trashOpen && markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
          </Text>
        }
        list={
          <List
            reversed={reversed}
            onPick={select}
            // Load more takes a single click; on a session, a double click does what Enter does.
            onClick={(i) => {
              const e = list[i];
              if (isLoadMore(e)) return loadMore();
              if (!isDoubleClick(i) || i !== index || trashOpen) return;
              if (isImport(e)) askImport();
              else if (isSession(e)) start(e);
            }}
            items={list}
            shown={filter.shown}
            pinned={filter.pinned}
            filter={filter.banner}
            selected={index}
            centre={trashOpen ? "trash" : restoredShown.current}
            height={bodyHeight}
            empty={trashOpen ? "Trash is empty" : (filter.empty ?? (sessions ? "No sessions" : "…"))}
            itemKey={entryId}
            time={listedAt}
            // The account's bar stays in its colour on the selected row too.
            lead={withAccounts ? (s) => (isSession(s) ? <Text color={barColor(s)}>▌</Text> : undefined) : undefined}
            render={(s, isSelected) => {
              if (isLoadMore(s)) return <LoadMoreRow progress={range.requested ? progress : undefined} />;
              if (isImport(s)) return <ImportRow />;
              const marked = favorites.isMarked(sessionKey(s));
              const state = stateOf(s);
              const gone = !state && folderGone(s);
              const badge = state === "active" ? "● " : state === "running" ? "▶ " : "";
              // Went on in another account (⇢), or is the copy of one from another (⇠).
              const transfer = state === "trash" ? undefined : transferOf(s);
              const moved = transfer?.to ? "⇢ " : transfer?.from ? "⇠ " : "";
              // A /rename title is bright, a first prompt standing in for it dim and quoted.
              // The quotes go around the cut text, so the closing one is never cut off.
              const quoted = titleIsPrompt(s);
              return (
                <>
                  {/* After the bar (lead), in the selection's style. */}
                  {withAccounts && " "}
                  {marked && <Star />}
                  {/* Without the date separators, the date is back in each row. */}
                  <Text dimColor={!isSelected}>{separators ? time(listedAt(s)) : dateTime(listedAt(s))} </Text>
                  {badge && <SessionMarker symbol={badge} activity={running.get(sessionKey(s))?.activity} />}
                  {gone && <Text dimColor>∅ </Text>}
                  {moved && <Text color="magenta">{moved}</Text>}
                  {all &&
                    (gone ? (
                      <>
                        <Text dimColor strikethrough>
                          {truncate(projectName(s), 12)}
                        </Text>
                        <Text> </Text>
                      </>
                    ) : (
                      <Text color="cyan">{`${truncate(projectName(s), 12)} `}</Text>
                    ))}
                  {/* The selected row keeps the quotes but not the gray, which is hard to read on the selection bar. */}
                  <Text color={s.title !== undefined && !isSelected ? "whiteBright" : undefined} dimColor={quoted && !isSelected}>
                    {quoted && "„"}
                    <EntryText
                      text={sessionTitle(s)}
                      width={Math.max(
                        4,
                        listWidth -
                          (separators ? 7 : 13) -
                          (withAccounts ? 2 : 0) -
                          (marked ? 2 : 0) -
                          (badge || gone ? 2 : 0) -
                          (moved ? 2 : 0) -
                          (all ? Math.min(12, projectName(s).length) + 1 : 0) -
                          (quoted ? 2 : 0),
                      )}
                      selected={isSelected}
                      active={active && !dialogOpen}
                    />
                    {quoted && "“"}
                  </Text>
                </>
              );
            }}
          />
        }
        preview={preview}
        footer={flash ?? footer}
      />
      {confirmation && (
        <ConfirmDialog layout={layout} confirmation={confirmation} onClose={() => setConfirmation(undefined)} />
      )}
      {choice && (
        <ChoiceDialog key={choice.title} layout={layout} choice={choice} onClose={closeChoice} />
      )}
      {renaming && (
        <RenameDialog
          layout={layout}
          lines={headFor(renaming)}
          title={renaming.title ?? ""}
          onSave={(title) => rename(renaming, title)}
          onCancel={() => setRenaming(undefined)}
        />
      )}
      {exporting && (
        <ExportDialog
          layout={layout}
          lines={exporting.lines}
          warning={exporting.sessions.some((s) => isActive(s) || running.has(sessionKey(s))) ? "A running session is exported as it stands now." : undefined}
          initial={exporting.opts}
          onExport={(opts) => runExport(exporting.sessions, opts)}
          onClose={() => setExporting(undefined)}
        />
      )}
      {importFrom !== undefined && <ImportDialog layout={layout} initial={importFrom} into={tilde(cwd)} onImport={runImport} onClose={() => setImportFrom(undefined)} />}
      {flow.element}
      {filter.dialog}
    </>
  );
}
