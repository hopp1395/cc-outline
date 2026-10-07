import { Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { detectTerminal, resumeForPairing, resumeInNewWindow } from "../open.js";
import { downloadsDir, EXPORT_NAME, exportSessions, freeName, importArchive, importSummary, newestExport, readExportOptions, saveExportOptions, type ExportProgress, type ExportResult } from "../export/archive.js";
import { EXPORT_FORMATS, type ExportOptions } from "../export/session.js";
import { ExportDialog } from "./ExportDialog.js";
import { ImportDialog } from "./ImportDialog.js";
import { useProgress, useProgressOpen, type Progress } from "./ProgressDialog.js";
import type { Placement } from "../settings.js";
import { focusClaudePane, prepareConsoleInput, resumeHereMethod, resumeInClaude, resumeSlashCommand, switchToSession, type ConsoleTyper } from "../switchSession.js";
import { cancelPairing, requestPairing, runningViewer, type PairTarget } from "../viewer.js";
import { ChoiceDialog, type Choice } from "./ChoiceDialog.js";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog.js";
import { RenameDialog } from "./RenameDialog.js";
import { enterLabel, sessionOptions, type SessionAction, type SessionSituation } from "./resumeChoice.js";
import { dayOf, linesByDay } from "./days.js";
import { formatMs, isCommand, type AgentStatus, type PlanStatus } from "../transcript/parse.js";
import { doubleClicks } from "./openKey.js";
import { useFocused } from "./focus.js";
import { useClipboard } from "./useClipboard.js";
import {
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
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
import { haystack, type FilterText } from "../filter.js";
import { useFavorites } from "./useFavorites.js";
import { useOnReload, useReload } from "./reload.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { useSetting } from "./useSetting.js";
import { projectSlug } from "../transcript/locate.js";
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
}

/** How often the sessions are re-read while the view is shown; only changed files are parsed again. */
const REFRESH_MS = 3000;
/** How long a viewer waits for the Claude Code it started to show up, before it stays unpaired. */
export const PAIR_TIMEOUT_MS = 30_000;

const STATUS_ICON: Record<PlanStatus, string> = {
  draft: "\u001b[36m✎\u001b[39m",
  approved: "\u001b[32m✓\u001b[39m",
  rejected: "\u001b[31m✗\u001b[39m",
  pending: "\u001b[33m●\u001b[39m",
};
const green = (s: string) => `\u001b[32m${s}\u001b[39m`;
const red = (s: string) => `\u001b[31m${s}\u001b[39m`;
const yellow = (s: string) => `\u001b[33m${s}\u001b[39m`;
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
/** "2026-09-26 20:48–22:53", with the end date only when it differs. */
function span(start?: string, end?: string): string {
  if (!start) return "";
  const s = new Date(start);
  const date = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!end) return `${date(s)} ${time(start)}`;
  const e = new Date(end);
  if (date(e) === date(s) && time(end) === time(start)) return `${date(s)} ${time(start)}`;
  return `${date(s)} ${time(start)}–${date(e) === date(s) ? "" : date(e) + " "}${time(end)}`;
}

/** Replaces the home directory with ~. */
function tilde(path: string): string {
  const home = homedir();
  return path.toLowerCase().startsWith(home.toLowerCase()) ? "~" + path.slice(home.length) : path;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The name shown for a session: its /rename title, else its first prompt that is not a slash or `!` command. */
function sessionTitle(s: SessionSummary): string {
  return s.title ?? (s.prompts.find((p) => !isCommand(p.text)) ?? s.prompts[0])?.text ?? s.id;
}

/** Whether `sessionTitle` falls back to a prompt, since the session has no /rename title. */
const titleIsPrompt = (s: SessionSummary) => s.title === undefined && s.prompts.length > 0;

/** Shell command that continues the session in Claude Code. */
export function resumeCommand(s: SessionSummary): string {
  return `claude --resume ${s.id}`;
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

function sessionHeader(s: SessionSummary, state: State, width: number, deletedAt?: number, activity?: SessionActivity): string[] {
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
      : `${state === "active" ? "active · " : state === "running" ? "running elsewhere · " : ""}${activity ? ACTIVITY_TEXT[activity] : ""}${resumeCommand(s)}`;
  // A session Claude Code went on with under a new id is shown as one; it names the ids it continues.
  const continues = s.continues?.length ? [dim(`continues ${s.continues.map((id) => id.slice(0, 8)).join(", ")}`)] : [];
  return previewHeader(sessionTitle(s), width, {
    marker: state === "active" || state === "running" ? (activity === "waiting" ? yellow : green)(state === "active" ? "● " : "▶ ") : "  ",
    style: bold,
    details: [when, counts.join(" · "), ...(s.cwd ? [`in ${tilde(s.cwd)}`] : []), ...continues, last],
  });
}

/**
 * The sessions of the project (or, with `all`, of every project) and which of
 * them run in a Claude Code process, read while `visible` and refreshed every
 * few seconds. The first scan fills the list as it goes; `progress` counts the
 * transcripts read so far. `refresh` rescans at once. A reload of the view
 * (F5) reads every transcript again with a new index; the list stays until
 * that scan is done. With `since`, only transcripts written since then are
 * read; when it changes (load more), the list also stays until the scan is done.
 */
function useSessions(cwd: string, visible: boolean, all: boolean, since: number | undefined) {
  const index = useRef(new SessionIndex());
  const reload = useReload();
  const loaded = useRef(reload.count);
  const sinceRef = useRef(since);
  const scanRef = useRef<() => Promise<void>>(async () => {});
  const [sessions, setSessions] = useState<SessionSummary[]>();
  // The last finished scan read every transcript (no `since`).
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>();

  useEffect(() => {
    if (!visible) return;
    const fresh = reload.count !== loaded.current;
    loaded.current = reload.count;
    if (fresh) index.current = new SessionIndex();
    const extending = since !== sinceRef.current;
    sinceRef.current = since;
    const current = index.current;
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
        const result = await current.scan(all ? undefined : cwd, (partial, done, total) => {
          // Only the first scan shows partial lists; later ones just update the finished list.
          // A reload keeps the list and shows only the progress.
          if (cancelled || !first) return;
          if (!reloading && !extending) setSessions(partial);
          setProgress({ done, total });
        }, since);
        if (!cancelled) {
          first = false;
          setSessions(result);
          setComplete(since === undefined);
          setProgress(undefined);
        }
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
  }, [cwd, visible, all, reload.count, since]);

  return { sessions, progress, complete, refresh: () => void scanRef.current() };
}

const sameRunning = (a: Map<string, RunningSession>, b: Map<string, RunningSession>) =>
  a.size === b.size &&
  [...a].every(([id, r]) => {
    const o = b.get(id);
    return o !== undefined && o.pid === r.pid && o.activity === r.activity && o.name === r.name;
  });

/**
 * The sessions running in a Claude Code process and what it does in each, read every second while
 * `visible`; the map only changes when one of them does, so the memoized header stays.
 */
function useRunning(visible: boolean): Map<string, RunningSession> {
  const [running, setRunning] = useState<Map<string, RunningSession>>(() => new Map());
  useEffect(() => {
    if (!visible) return;
    const read = () => {
      const next = runningSessions();
      setRunning((prev) => (sameRunning(prev, next) ? prev : next));
    };
    read();
    const timer = setInterval(read, TIMING.activityPoll);
    return () => clearInterval(timer);
  }, [visible]);
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
function sessionText(s: SessionSummary): FilterText {
  return {
    list: haystack([sessionTitle(s), projectName(s)]),
    details: haystack([
      s.cwd,
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

/** An entry of the list: a session, or load more at its oldest end. */
type Entry = SessionSummary | LoadMore;
const LOAD_MORE_ID = "load-more";
const entryId = (e: Entry) => (isLoadMore(e) ? LOAD_MORE_ID : e.id);

/** The wait for a started Claude Code to pair with. */
interface Pairing {
  sessionId: string;
  cwd: string;
  transcript: string;
  /** Where it runs: a Windows Terminal window name or a tmux pane id; not yet known while it is being started. */
  where?: string;
  /** Epoch ms. */
  started: number;
  /** It did not start or show up in time: what the dialog says until Esc. */
  failed?: { text: string; lines: string[] };
}

/** The pairing's progress dialog: starting Claude Code, waiting for it (Esc cancels), or why it failed. */
export function pairingProgress(pairing: Pairing, now: number, onCancel: () => void, onClose: () => void): Progress {
  const title = "Attach the viewer";
  if (pairing.failed) return { title, status: "failed", ...pairing.failed, onClose };
  if (pairing.where === undefined) return { title, status: "running", text: "Starting Claude Code", onCancel };
  const total = PAIR_TIMEOUT_MS / 1000;
  const waited = Math.min(total, Math.floor((now - pairing.started) / 1000));
  return { title, status: "running", text: "Waiting for Claude Code", detail: `${waited} of ${total} s · the viewer moves next to it once it runs`, onCancel };
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

export function SessionsView({ cwd, activePath, layout, visible, active, onTrashOpen, onModal, onTyping, onPair, paired, onPairStarted, onDetach }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const [isDoubleClick] = useState(() => doubleClicks());
  const copy = useClipboard();
  const [all, setAll] = useSetting("allProjects");
  const [separators] = useSetting("dateSeparators");
  const [pinnedSessions] = useSetting("pinnedSessions");
  const range = useListRange("sessionsRange");
  const { sessions: read, progress, complete, refresh } = useSessions(cwd, visible, all, range.since);
  const running = useRunning(visible);
  const activeId = activePath ? basename(activePath, ".jsonl") : undefined;
  // The sessions last worked in during the range (see lastActive); the active and running ones also when that was before it.
  const sessions = useMemo(() => {
    const since = range.since;
    if (!read || since === undefined) return read;
    return read.filter((s) => {
      const at = lastActive(s);
      return !at || Date.parse(at) >= since || s.id === activeId || running.has(s.id);
    });
  }, [read, range.since, activeId, running]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  // The session moved to the trash last, for u (undo) in the list.
  const [lastTrashed, setLastTrashed] = useState<SessionSummary>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  // Enter on a session that runs nowhere: where to continue it; then, for pairing, the wait for its Claude Code.
  const [choice, setChoice] = useState<Choice<SessionAction>>();
  const [pairing, setPairing] = useState<Pairing>();
  // The session being renamed, while its dialog is open.
  const [renaming, setRenaming] = useState<SessionSummary>();
  const [, setPairTick] = useState(0);
  // e: the sessions to export, while the form is open; I: the import dialog; then the run of either.
  const [exporting, setExporting] = useState<{ sessions: SessionSummary[]; opts: ExportOptions; lines: string[] }>();
  // The archive the import dialog proposes ("" for none), while it is open.
  const [importFrom, setImportFrom] = useState<string>();
  const [run, setRun] = useState<Progress>();
  // The app's progress dialog shows the export, the import or the wait for a Claude Code to attach to.
  const progressOpen = useProgressOpen();
  const dialogOpen =
    confirmation !== undefined || choice !== undefined || renaming !== undefined || exporting !== undefined || importFrom !== undefined || run !== undefined || pairing !== undefined || progressOpen;
  // Selection and each session's scroll position survive switching sessions and restarting the viewer.
  const positions = usePositions(cwd, "sessions");
  // Selected by id, so the selection stays when sessions are added; none yet means the newest.
  const [selectedId, setSelectedId] = useState<string | undefined>(positions.selected);
  const storedId = useRef(positions.selected);
  const restoredShown = useRef(false);
  const [trashSelectedId, setTrashSelectedId] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const favorites = useFavorites(cwd, "sessions");

  // The sessions are kept oldest first and shown newest first, so load more (the oldest end) comes last;
  // the trash is kept and shown with the latest deletion first.
  const reversed = !trashOpen;
  const more = showsLoadMore(range, complete);
  const sessionList: Entry[] = useMemo(() => (more && sessions ? [LOAD_MORE, ...sessions] : (sessions ?? [])), [more, sessions]);
  const list: Entry[] = trashOpen ? trash.map((e) => e.summary) : sessionList;
  // The time the list is sorted by and shown with: the last question to Claude (lastActive), in the trash the deletion.
  const deletedAt = new Map(trash.map((e) => [e.id, e.deletedAt]));
  const listedAt = (s: Entry) => {
    if (isLoadMore(s)) return undefined;
    const deleted = trashOpen ? deletedAt.get(s.id) : undefined;
    return deleted !== undefined ? new Date(deleted).toISOString() : lastActive(s);
  };
  const markedCount = (sessions ?? []).filter((s) => favorites.isMarked(s.id)).length;
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
    text: (e) => (isLoadMore(e) ? { list: "", details: "" } : sessionText(e)),
    selected: sessionFound >= 0 ? sessionFound : sessionList.length - 1,
    select: (i) => select(i),
    reversed: true,
    layout,
    enabled: !trashOpen,
    onTyping,
    keep: isLoadMore,
    marked: (e) => !isLoadMore(e) && favorites.isMarked(e.id),
    pin: pinnedSessions ? (e) => !isLoadMore(e) && (e.id === activeId || running.has(e.id)) : undefined,
    restoreCopy: positions.pinned ? (e) => !isLoadMore(e) && e.id === storedId.current : undefined,
  });
  // Only a selection made (or restored) counts; the default "newest" of a half-read list is not stored.
  useEffect(() => {
    if (selectedId !== LOAD_MORE_ID) positions.select(selectedId, undefined, filter.copySelected);
  }, [selectedId, filter.copySelected]);
  const picked = filter.none ? undefined : list[index];
  const onLoadMore = isLoadMore(picked);
  const session = isLoadMore(picked) ? undefined : picked;
  // The oldest session before load more was clicked: the one read next to it gets the selection.
  const loadedAfter = useRef<string | undefined>(undefined);
  const loadMore = () => {
    if (range.requested) return;
    loadedAfter.current = sessions?.[0]?.id;
    range.loadAll();
  };
  // Once the whole history is read and the entry is gone, the selection moves to the newest of the sessions read now.
  useEffect(() => {
    if (more || selectedId !== LOAD_MORE_ID || !sessions) return;
    const at = sessions.findIndex((s) => s.id === loadedAfter.current);
    setSelectedId(sessions[at >= 0 ? Math.max(0, at - 1) : sessions.length - 1]?.id);
  }, [more, sessions]);
  const entry = trashOpen ? trash[index] : undefined;
  const stateOf = (s: SessionSummary): State =>
    trashOpen ? "trash" : s.id === activeId ? "active" : running.has(s.id) ? "running" : undefined;

  const header = useMemo(() => {
    if (!session) return [];
    const state = stateOf(session);
    const activity = state === "active" || state === "running" ? running.get(session.id)?.activity : undefined;
    return fitHeader(sessionHeader(session, state, previewWidth, entry?.deletedAt, activity), bodyHeight);
  }, [session, activeId, running, trashOpen, entry, previewWidth, bodyHeight]);
  const lines = useMemo(
    () => (session ? sessionLines(session, cwd, previewWidth, separators) : []),
    [session, cwd, previewWidth, separators],
  );
  const viewport = bodyHeightBelow(header, bodyHeight);
  const scroll = positions.scroll(session?.id, lines.length, viewport);

  useEffect(() => onModal?.(dialogOpen), [dialogOpen]);
  useEffect(() => onTrashOpen?.(trashOpen), [trashOpen]);

  const select = (next: number) => {
    const target = list[Math.max(0, Math.min(list.length - 1, next))];
    if (!target || target === picked) return;
    setCurrentId(entryId(target));
  };
  /** After removing the selected entry: select its neighbour, a session rather than load more. */
  const selectNeighbour = () =>
    setCurrentId([list[index + 1], list[index - 1]].find((e): e is SessionSummary => e !== undefined && !isLoadMore(e))?.id);

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
  // F5 in the trash reads it again too.
  useOnReload(() => {
    if (trashOpen) setTrash(listTrash(trashScope));
  });

  /**
   * Where `s` stands for Enter: the viewer's own session (paired viewers only), running in a Claude Code
   * (the one it runs in, `claude`), or nowhere; and what keeps an action from being chosen.
   */
  const situationOf = (s: SessionSummary) => {
    const dir = s.cwd ?? cwd;
    const claude = running.get(s.id);
    const own = paired && [...running.values()].find((r) => r.pid === paired.claudePid);
    const state: SessionSituation["state"] = paired && s.id === activeId ? "current" : claude ? "active" : "inactive";
    const situation: SessionSituation = {
      paired: paired && { empty: paired.empty, activity: own ? own.activity : undefined, method: resumeHereMethod() },
      state,
      attachBlocked: !onPair ? "this viewer cannot attach" : claude && runningViewer(dir, claude.pid) ? "it has a viewer of its own" : undefined,
      // /resume finds only the sessions of the project folder its Claude Code runs in, this viewer's.
      otherFolder: projectSlug(dir) === projectSlug(cwd) ? undefined : truncate(basename(dir), 20),
      folderMissing: state === "inactive" && !existsSync(dir),
      terminal: detectTerminal() !== undefined,
      // A session the Claude Code daemon runs is attached to, not resumed.
      command: claude?.kind === "bg" && claude.jobId ? `claude attach ${claude.jobId}` : resumeCommand(s),
    };
    return { situation, claude, dir };
  };

  const CHOICE_TITLES: Record<SessionSituation["state"], string> = {
    current: "This viewer's session",
    active: "This session runs in a Claude Code",
    inactive: "Continue this session where?",
  };

  /** Enter: asks what to do with the session (`sessionOptions`), with the usual choice selected. */
  const start = (s: SessionSummary) => {
    const { situation, claude, dir } = situationOf(s);
    const lines = [
      truncate(sessionTitle(s), 56),
      `${span(s.start, s.end)} · ${plural(s.prompts.length, "prompt")} · ${plural(s.files.length, "file")}`,
      truncate(`in ${tilde(dir)}`, 56),
    ];
    const { options, initial } = sessionOptions(situation);
    // On Windows, PowerShell takes a second or more to start: it does so while the dialog is open.
    const here = options.find((o) => o.id === "here");
    if (paired && here && !here.disabled && resumeHereMethod() === "keys" && detectTerminal() !== "tmux") typer.current = prepareConsoleInput(paired.claudePid);
    setChoice({
      title: CHOICE_TITLES[situation.state],
      lines,
      options,
      initial,
      onChoose: (id) => {
        const prepared = takeTyper();
        if (id !== "here") prepared?.cancel();
        // Attaching to a new window then waits in the progress dialog.
        setChoice(undefined);
        act(id, s, dir, claude, situation.command, prepared);
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
        notify(resumeInNewWindow(s.id, dir, truncate(sessionTitle(s), 30)));
        // Show it as running as soon as Claude Code registers it.
        setTimeout(refresh, 3000);
        return;
      case "window-attach":
        return void startPairing(s, dir);
      case "rename":
        return setRenaming(s);
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

  /** Starts the session in a new window, where Claude Code's hook leaves opening a viewer to this one, then waits for it. */
  const startPairing = async (s: SessionSummary, dir: string) => {
    requestPairing(dir, s.id, Date.now() + 2 * PAIR_TIMEOUT_MS);
    // Waiting from now on, so a second Enter starts nothing more.
    const started: Pairing = { sessionId: s.id, cwd: dir, transcript: s.path, started: Date.now() };
    setPairing(started);
    const { message, target } = await resumeForPairing(s.id, dir, truncate(sessionTitle(s), 30));
    if (!target) {
      cancelPairing(dir, s.id);
      return setPairing((p) => (p === started ? { ...started, failed: { text: "Claude Code did not start", lines: [message] } } : p));
    }
    setPairing((p) => (p === started ? { ...started, where: target } : p));
  };
  /** Esc while it waits: the request is withdrawn; the Claude Code started keeps running. */
  const cancelWait = () => {
    if (pairing) cancelPairing(pairing.cwd, pairing.sessionId);
    setPairing(undefined);
    notify("pairing cancelled; Claude Code keeps running in its window");
  };
  // Waiting: pairs once the session's Claude Code registers itself, gives up after PAIR_TIMEOUT_MS.
  useEffect(() => {
    if (!pairing || pairing.failed) return;
    const timer = setInterval(() => {
      const claude = pairing.where !== undefined ? runningSessions().get(pairing.sessionId) : undefined;
      if (claude && pairing.where !== undefined) {
        clearInterval(timer);
        setPairing(undefined);
        // The request stays for its hook, which may be still to come; it expires by itself.
        return onPairStarted?.({ cwd: pairing.cwd, claudePid: claude.pid, sessionId: pairing.sessionId, transcript: pairing.transcript }, pairing.where);
      }
      if (Date.now() - pairing.started >= PAIR_TIMEOUT_MS) {
        clearInterval(timer);
        cancelPairing(pairing.cwd, pairing.sessionId);
        const failed = {
          text: `Claude Code did not show up within ${PAIR_TIMEOUT_MS / 1000} s`,
          lines: ["The viewer stays as it was; the Claude Code started keeps running in its window."],
        };
        return setPairing((p) => (p === pairing ? { ...pairing, failed } : p));
      }
      setPairTick((n) => n + 1);
    }, TIMING.pairPoll);
    return () => clearInterval(timer);
  }, [pairing]);
  useProgress(
    pairing
      ? pairingProgress(pairing, Date.now(), cancelWait, () => setPairing(undefined))
      : run && { ...run, onClose: () => setRun(undefined) },
  );

  const askDelete = (s: SessionSummary) => {
    const blocker = deleteBlocker(s.id, activeId, runningSessionIds());
    if (blocker) return notify(blocker);
    setConfirmation({
      title: "Move this session to the trash?",
      lines: [
        truncate(sessionTitle(s), 56),
        `${span(s.start, s.end)} · ${plural(s.prompts.length, "prompt")} · ${plural(s.files.length, "file")}`,
        "You can restore it from the trash (T).",
      ],
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
        truncate(sessionTitle(s), 56),
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
      lines: [`${plural(trash.length, "session")} ${all ? "of all projects" : "of this project"} will be deleted for good.`, "This can't be undone."],
      danger: true,
      onConfirm: () => attempt(() => void emptyTrash(trashScope, cwd), "trash emptied"),
    });
  };

  /** e: the marked sessions, else the selected one, with the form for the options. */
  const askExport = () => {
    const marked = (sessions ?? []).filter((s) => favorites.isMarked(s.id));
    const targets = marked.length ? marked : session ? [session] : [];
    if (targets.length) setExporting({ sessions: targets, opts: readExportOptions(), lines: exportLines(targets) });
  };
  const exportLines = (targets: SessionSummary[]) => {
    const file = freeName(downloadsDir(), EXPORT_NAME);
    const dir = tilde(dirname(file));
    const one = targets.length === 1 ? targets[0] : undefined;
    return [
      ...(one
        ? [truncate(sessionTitle(one), 56), `${span(one.start, one.end)} · ${plural(one.prompts.length, "prompt")} · ${plural(one.files.length, "file")}`]
        : [`${plural(targets.length, "marked session")}`]),
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
        const result = importArchive(file);
        const lines = [
          ...result.imported.map((s) => `  ✓ ${s.title}`),
          ...result.skipped.map((s) => `  – ${s.title}: ${s.reason}`),
        ].slice(0, 8);
        const summary = importSummary(result);
        setRun({ title: "Import", status: "done", text: summary[0]!.toUpperCase() + summary.slice(1), lines });
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
        setAll((a) => !a);
        // The trash follows the scope right away; the list follows with the next scan.
        if (trashOpen) setTrash(listTrash(all ? projectSlug(cwd) : undefined));
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
          if (favorites.isMarked(session.id)) filter.unmarking(index);
          return favorites.toggle(session.id);
        }
        if (mark) {
          const target = filter.nextMark(mark);
          return target !== undefined && select(target);
        }
        if ((input === "d" || key.delete) && session) return askDelete(session);
        if (input === "e") return askExport();
        if (input === "I") return setImportFrom(newestExport() ?? "");
        if (input === "u") {
          if (!lastTrashed) return notify("nothing to undo");
          const s = lastTrashed;
          return restore(s, () => setSelectedId(s.id));
        }
        if (key.return && onLoadMore) return loadMore();
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
  else if (onLoadMore) preview = <Text dimColor>{loadMoreLines(range, "sessions", sessionList.length - 1, range.requested).join("\n")}</Text>;
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
        { text: "a all", on: all, priority: 2 },
        { text: "T trash", on: true },
      ]
    : [
        { text: "↑↓ session", priority: 4 },
        { text: "PgUp/Dn scroll", priority: 1 },
        ...markFooter(favorites.isMarked(session?.id), markedCount),
        ...filter.footer,
        { text: onLoadMore ? "↵ load more" : session ? enterLabel(situationOf(session).situation) : "↵ start", priority: 3 },
        { text: "c copy resume", priority: 2 },
        { text: "d delete", priority: 2 },
        { text: markedCount > 0 ? "e export ★" : "e export", priority: 2 },
        { text: "I import", priority: 1 },
        ...(lastTrashed ? [{ text: "u undo", priority: 3 }] : []),
        { text: "a all", on: all, priority: 2 },
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
              if (isDoubleClick(i) && i === index && !trashOpen && e) start(e);
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
            render={(s, isSelected, stars) => {
              if (isLoadMore(s)) return <LoadMoreRow progress={range.requested ? progress : undefined} />;
              const marked = stars && favorites.isMarked(s.id);
              const state = stateOf(s);
              const badge = state === "active" ? "● " : state === "running" ? "▶ " : "";
              // A /rename title is bright, a first prompt standing in for it dim and quoted.
              // The quotes go around the cut text, so the closing one is never cut off.
              const quoted = titleIsPrompt(s);
              return (
                <>
                  {marked && <Star />}
                  {/* Without the date separators, the date is back in each row. */}
                  <Text dimColor={!isSelected}>{separators ? time(listedAt(s)) : dateTime(listedAt(s))} </Text>
                  {badge && <SessionMarker symbol={badge} activity={running.get(s.id)?.activity} />}
                  {all && <Text color="cyan">{`${truncate(projectName(s), 12)} `}</Text>}
                  {/* The selected row keeps the quotes but not the gray, which is hard to read on the selection bar. */}
                  <Text color={s.title !== undefined && !isSelected ? "whiteBright" : undefined} dimColor={quoted && !isSelected}>
                    {quoted && "„"}
                    <EntryText
                      text={sessionTitle(s)}
                      width={Math.max(
                        4,
                        listWidth -
                          (separators ? 7 : 13) -
                          (marked ? 2 : 0) -
                          badge.length -
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
        <ChoiceDialog layout={layout} choice={choice} onClose={closeChoice} />
      )}
      {renaming && (
        <RenameDialog
          layout={layout}
          session={truncate(sessionTitle(renaming), 56)}
          title={renaming.title ?? ""}
          onSave={(title) => rename(renaming, title)}
          onCancel={() => setRenaming(undefined)}
        />
      )}
      {exporting && (
        <ExportDialog
          layout={layout}
          lines={exporting.lines}
          warning={exporting.sessions.some((s) => s.id === activeId || running.has(s.id)) ? "A running session is exported as it stands now." : undefined}
          initial={exporting.opts}
          onExport={(opts) => runExport(exporting.sessions, opts)}
          onClose={() => setExporting(undefined)}
        />
      )}
      {importFrom !== undefined && <ImportDialog layout={layout} initial={importFrom} onImport={runImport} onClose={() => setImportFrom(undefined)} />}
      {filter.dialog}
    </>
  );
}
