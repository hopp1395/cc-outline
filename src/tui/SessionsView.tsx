import { Box, Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import stringWidth from "string-width";
import { attachmentFile, attachmentTitle, type AttachmentItem } from "../attachments.js";
import { describeRemoteError, RemoteSessions, remoteUrl } from "../remote/index.js";
import { displayPath, formatDuration, insideProject, lastActive, type SessionBackground, type SessionSummary } from "../transcript/sessions.js";
import {
  deleteBlocker,
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
import { AttachmentsDialog } from "./AttachmentsDialog.js";
import { runningRcViewer, type RcViewerInfo, type RcViewerSelect } from "../rcViewer/registry.js";
import { screenOrder } from "../pinned.js";
import { FocusContext } from "./focus.js";
import { useMouse } from "./mouse.js";
import { detectTerminal, focusSessionViewer, openInDefaultApp, openRcViewer, openSessionViewer, resumeInNewWindow, resumeShellCommand, viewerCommand, type ViewerTarget } from "../open.js";
import { viewersOf, viewerWindow } from "../sessionViewers.js";
import { downloadsDir, EXPORT_NAME, exportSessions, freeName, importArchive, importSummary, newestExport, readExportOptions, saveExportOptions, type ExportProgress, type ExportResult } from "../export/archive.js";
import { moveSession } from "../export/move.js";
import { EXPORT_FORMATS, type ExportOptions } from "../export/session.js";
import { ExportDialog } from "./ExportDialog.js";
import { ImportDialog } from "./ImportDialog.js";
import { useProgress, useProgressOpen, type Progress } from "./ProgressDialog.js";
import { rangeStart, updateSettings, type Placement } from "../settings.js";
import { filterIsSet, filterSettings, passesFilter, sessionFilter, type SessionFilter } from "../sessionFilter.js";
import { filterAccounts, SessionFilterDialog } from "./SessionFilterDialog.js";
import { focusClaudePane, prepareConsoleInput, resumeHereMethod, resumeInClaude, resumeSlashCommand, switchToSession, type ConsoleTyper } from "../switchSession.js";
import { runningViewer, type PairTarget } from "../viewer.js";
import { otherAccounts } from "../accountContinue.js";
import { ACCOUNT_COLORS, avatarOfAccount, barColorOfAccount, type Account, type AccountColorName } from "../account.js";
import { pluginState } from "../accountSetup.js";
import { readTransfers, type Transfer } from "../transfers.js";
import { useAccountState } from "./useAccount.js";
import { useAccountFlow } from "./useAccountFlow.js";
import { countHead, fg, plural, sessionHead, sessionTitle, span, tilde, type HeadState } from "./sessionHead.js";
import { ChoiceDialog, type Choice } from "./ChoiceDialog.js";
import { remoteOptions, useRemoteControl, type RemoteAction } from "./useRemoteControl.js";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog.js";
import { RenameDialog } from "./RenameDialog.js";
import { enterLabel, rcViewerOption, OWN_ONLY, sessionOptions, type ChoiceOption, type SessionAction, type SessionSituation, viewerOptions } from "./resumeChoice.js";
import { dayOf, linesByDay } from "./days.js";
import { formatMs, type AgentStatus, type PlanStatus } from "../transcript/parse.js";
import { doubleClicks } from "./openKey.js";
import { useFocused } from "./focus.js";
import { useClipboard } from "./useClipboard.js";
import {
  AreaContext,
  columnWidthOf,
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
import { useOnReload } from "./reload.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { useSetting } from "./useSetting.js";
import { claudeDir, inClaudeDir, projectSlug } from "../transcript/locate.js";
import { renameAnywhere, renamePlan, type RenameSituation } from "../sessionRename.js";
import { isLoadMore, LOAD_MORE, LoadMoreRow, loadMoreLines, showsLoadMore, useListRange, type LoadMore } from "./loadMore.js";
import { TIMING } from "../timing.js";
import { mergeRemote, sessionKey, useRemoteSessions, useRunning, useSessions, useSessionViewers, withNames } from "./useSessionData.js";

interface Props {
  cwd: string;
  /** Transcript of the session the other views show; marked as the active one. */
  activePath?: string;
  layout: Layout;
  /** The view is shown; sessions are only read while it is. */
  visible: boolean;
  /** The view takes keys. */
  active: boolean;
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
  /** /cco:account: asks which account to continue the active session in (`query` may name it); once per `at`. */
  accountRequest?: { at: number; query?: string };
}

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
const cyan = (s: string) => `\u001b[36m${s}\u001b[39m`;
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


/** Whether `sessionTitle` falls back to a prompt, since the session has no name of its own. */
const titleIsPrompt = (s: SessionSummary) => s.title === undefined && s.aiTitle === undefined && s.name === undefined && s.prompts.length > 0;

/** Shell command that continues the session in Claude Code; for another account's, under its config folder. */
export function resumeCommand(s: SessionSummary): string {
  // A remote session is continued in the Claude app or on claude.ai, not with a command: its address stands in.
  if (s.remote) return remoteUrl(s.id);
  return s.account ? resumeShellCommand(s.id, s.account) : `claude --resume ${s.id}`;
}

export { sessionKey };

/** The mark of a background session in the list, before its title. */
const BACKGROUND_MARK = "◌";

/** How a background session ran, as the header and the filter's details name it. */
const BACKGROUND_TEXT: Record<SessionBackground, string> = { sdk: "claude -p / SDK", daemon: "daemon" };

/** How a session ran in the background, if it did: from its transcript, else from the daemon running it now. */
export function backgroundOf(s: SessionSummary, running?: RunningSession): SessionBackground | undefined {
  return s.background ?? (running?.kind === "bg" ? "daemon" : undefined);
}

/** The header's line about a background session: how it ran, and while the daemon runs it, the command that attaches to it. */
export function backgroundLine(background: SessionBackground | undefined, running?: RunningSession): string | undefined {
  if (!background) return undefined;
  const attach = background === "daemon" && running?.kind === "bg" && running.jobId ? ` · claude attach ${running.jobId}` : "";
  return dim(`${BACKGROUND_MARK} background: ${BACKGROUND_TEXT[background]}${attach}`);
}

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

/** The mark of a remote session in the list, before its title, and of a session of this machine that is connected to claude.ai. */
const REMOTE_MARK = "◈";
/** Viewers of the session run in windows of their own (`cco watch --session`, `--remote`); with a count from two on. */
const VIEWED_MARK = "◎";
/** How many images and PDFs a session has, in its row: "▣3". */
const MEDIA_MARK = "▣";
/** How many dynamic workflows Claude started in a session, in its row: "◇2"; one without a count. */
const WORKFLOW_MARK = "◇";
const CONNECTED_MARK = "⇄";

/** The header's line about a remote session: what claude.ai says of it, and what could not be shown. */
export function remoteLine(s: SessionSummary): string | undefined {
  const r = s.remote;
  if (!r) return undefined;
  const unknown = r.unknown ? Object.entries(r.unknown).map(([type, n]) => `${n} ${type}`).join(", ") : "";
  const parts = [
    "remote",
    r.workerStatus === "running" ? "working" : r.workerStatus === "requires_action" ? "waiting for input" : r.workerStatus,
    r.connectionStatus,
    ...(r.error ? [`events: ${r.error}`] : []),
    ...(r.truncated ? ["older events not read"] : []),
    ...(unknown ? [`not shown: ${unknown}`] : []),
  ].filter(Boolean);
  return dim(`${REMOTE_MARK} ${parts.join(" · ")}`);
}

/** Status of a subagent in the overview, like the chat's agent blocks. */
const AGENT_ICON: Record<AgentStatus, string> = {
  running: yellow("⠿"),
  completed: green("✓"),
  failed: red("✗"),
  killed: red("■"),
};

/**
 * The transcript's place in the details: the chain's latest (`SessionSummary.path`), in the trash where it
 * went (`TrashEntry.items`).
 */
function transcriptLocation(s: SessionSummary, trashed?: TrashEntry): string | undefined {
  return trashed?.items.find((i) => i.from === s.path)?.to ?? s.path;
}

/** The images and PDFs of a session (`▣n` in the list); its @-mentions do not count. */
const mediaOf = (s: SessionSummary) => (s.attachments ?? []).filter((a) => a.kind !== "file" && a.kind !== "directory").length;

/** A line of the Attachments section: symbol, time and what it is ("⎘ 14:32 [Image #1] · the prompt", "@ 15:02 src/Foo.cs (3×)"). */
function attachmentLine(a: AttachmentItem, cwd: string, width: number): string {
  const at = dim(time(a.at));
  switch (a.kind) {
    case "pasted":
      return truncate(`  ${magenta("⎘")} ${at} ${cyan(`[Image #${a.n}]`)}${a.prompt ? dim(` · ${a.prompt}`) : ""}`, width);
    case "image":
    case "pdf":
      return truncate(`  ${cyan(a.kind === "pdf" ? "▤" : "▣")} ${at} ${a.label}`, width);
    default: {
      // As the prompt named it (relative to the session's folder), else relative to that folder.
      const path = (a.path !== a.full ? a.path : displayPath(a.full, cwd)).replace(/\\/g, "/");
      const times = (a.uuids?.length ?? 0) > 1 ? dim(` (${a.uuids!.length}×)`) : "";
      return truncate(`  ${yellow("@")} ${at} ${a.kind === "directory" ? path.replace(/\/?$/, "/") : path}${times}`, width);
    }
  }
}

/**
 * Transcript, plans, workflows, attachments, agents, changed files and prompts of a
 * session, as lines of `width` columns. `rows`, if given, gets the line of
 * each attachment (line index → index in `s.attachments`), for clicks.
 */
export function sessionLines(
  s: SessionSummary,
  viewerCwd: string,
  width: number,
  separators = true,
  location?: string,
  rows?: Map<number, number>,
): string[] {
  // Paths are shown relative to the folder the session ran in.
  const cwd = s.cwd ?? viewerCwd;
  const lines: string[] = [];
  // Over several days, each day starts with a separator; a single day is named by the header.
  const severalDays = separators && dayOf(s.start) !== dayOf(s.end ?? s.start);
  const timed = <T,>(items: T[], at: (item: T) => string | undefined, line: (item: T) => string) =>
    severalDays ? linesByDay(items, at, line, width) : items.map(line);
  if (location) lines.push(heading("Transcript"), ...wrapPath(location, width - 2).map((l) => `  ${l}`));
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
  const workflows = s.workflows ?? [];
  if (workflows.length > 0) {
    section(
      "Workflows",
      workflows.length,
      timed(workflows, (w) => w.started, (w) => {
        const name = w.resumeOf ? `${w.name ?? "workflow"} ↻` : (w.name ?? "workflow");
        const facts = [...(w.agents !== undefined ? [plural(w.agents, "agent")] : []), ...(w.durationMs !== undefined ? [formatMs(w.durationMs)] : [])].join(" · ");
        // Cut as plain text; what follows the name is dimmed.
        const text = truncate([name, ...(facts ? [facts] : []), ...(w.description ? [w.description] : [])].join(" · "), width - 10);
        return `  ${AGENT_ICON[w.status]} ${dim(time(w.started))} ${text.slice(0, name.length)}${dim(text.slice(name.length))}`;
      }),
    );
  }
  const attachments = s.attachments ?? [];
  if (attachments.length > 0) {
    const rendered = attachments.map((a) => attachmentLine(a, cwd, width));
    const start = lines.length;
    section(
      "Attachments",
      attachments.length,
      [...timed(attachments.map((_, i) => i), (i) => attachments[i].at, (i) => rendered[i]), dim("  o lists them, a click opens one")],
    );
    // Day separators come between them: each attachment's line is found in order.
    let from = start;
    rendered.forEach((line, i) => {
      const at = lines.indexOf(line, from);
      if (at < 0) return;
      rows?.set(at, i);
      from = at + 1;
    });
  }
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
  background?: string,
  inWindows?: string,
): string[] {
  const when = [span(s.start, s.end), formatDuration(s.start, s.end), s.branch].filter(Boolean).join(" · ");
  const counts = [
    plural(s.remote && !s.remote.loaded ? (s.remote.userMessages ?? 0) : s.prompts.length, "prompt"),
    plural(s.plans.length, "plan"),
    ...(s.agents?.length ? [plural(s.agents.length, "agent")] : []),
    ...(s.workflows?.length ? [plural(s.workflows.length, "workflow")] : []),
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
    details: [
      when,
      counts.join(" · "),
      ...account,
      ...(s.cwd ? [gone ? red(`folder gone: ${tilde(s.cwd)}`) : `in ${tilde(s.cwd)}`] : []),
      ...(background ? [background] : []),
      ...(inWindows ? [inWindows] : []),
      ...continues,
      ...transferLines(transfer),
      last,
    ],
  });
}

/** The selected remote session `base` with its events read (prompts, plans, files), again whenever the list says it changed. */
function useRemoteDetail(base: SessionSummary | undefined, visible: boolean): SessionSummary | undefined {
  const [detail, setDetail] = useState<SessionSummary>();
  const id = base?.remote ? base.id : undefined;
  const stamp = base && `${base.modified}|${base.remote?.workerStatus}`;
  useEffect(() => {
    if (!base?.remote || !visible) return;
    let cancelled = false;
    new RemoteSessions().detail(base).then(
      (read) => !cancelled && setDetail(read),
      (err) => !cancelled && setDetail({ ...base, remote: { ...base.remote!, loaded: true, error: describeRemoteError(err) } }),
    );
    return () => {
      cancelled = true;
    };
  }, [id, stamp, visible]);
  return id !== undefined && detail?.id === id ? detail : undefined;
}


/** What the preview's header says about the viewers of a session in windows of their own. */
export const viewedLine = (n: number) => (n > 0 ? `${VIEWED_MARK} ${plural(n, "session viewer")} open` : undefined);

/**
 * The marker of the active (`●`) or a running (`▶`) session in the list: yellow while its Claude waits
 * for the user, green otherwise, turning bright and dim while it works. Owns its timer so only it
 * re-renders; the phase comes from the clock, so all working sessions blink together.
 */
export function SessionMarker({ symbol, activity, color = "green", flash = false }: { symbol: string; activity?: SessionActivity; color?: string; flash?: boolean }) {
  const busy = activity === "busy";
  const waiting = activity === "waiting";
  // Waiting (yellow) and `flash` (in its colour) go on and off; working goes bright and dim.
  const onOff = waiting || flash;
  const off = useBlinkOff(busy || onOff);
  if (onOff && off) return <Text>{" ".repeat(stringWidth(symbol))}</Text>;
  return (
    <Text color={waiting ? "yellow" : color} dimColor={busy && off}>
      {symbol}
    </Text>
  );
}

/**
 * Whether a blinking mark is in its off phase now: while `active`, re-renders at each change of phase. The phase comes
 * from the clock, so every mark blinks in step.
 */
export function useBlinkOff(active: boolean): boolean {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(() => {
        setTick((n) => n + 1);
        next();
      }, TIMING.blink - (Date.now() % TIMING.blink));
    };
    next();
    return () => clearTimeout(timer);
  }, [active]);
  return active && Math.floor(Date.now() / TIMING.blink) % 2 === 1;
}

/** Short name of the project a session belongs to: its folder name. */
export function projectName(s: SessionSummary): string {
  return s.cwd ? basename(s.cwd) : basename(dirname(s.path));
}

/** What a session is found by in the filter: in the list its title and project; in the details where and on which branch it ran, its prompts, files, plans and agents. */
function sessionText(s: SessionSummary, gone: boolean, email?: string, background?: SessionBackground): FilterText {
  return {
    list: haystack([sessionTitle(s), projectName(s), email]),
    details: haystack([
      s.cwd,
      gone ? "folder gone" : undefined,
      background ? `background ${BACKGROUND_TEXT[background]}` : undefined,
      s.branch,
      s.id,
      ...(s.continues ?? []),
      ...s.prompts.map((p) => p.text),
      ...s.files,
      ...(s.attachments ?? []).map((a) => (a.kind === "file" || a.kind === "directory" ? a.path : a.kind === "pasted" ? `[Image #${a.n}]` : a.label)),
      ...s.plans.map((p) => planTitle(p.text)),
      ...(s.agents ?? []).map((a) => a.description),
      ...(s.workflows ?? []).flatMap((w) => [w.name ?? "workflow", ...(w.description ? [w.description] : [])]),
    ]),
  };
}

/** Whether the Remote Control Viewer runs (its registration and process), read every second while `visible`. */
function useRcViewerRuns(visible: boolean): RcViewerInfo | undefined {
  const [rcViewer, setRcViewer] = useState<RcViewerInfo | undefined>(() => runningRcViewer());
  useEffect(() => {
    if (!visible) return;
    const read = () => setRcViewer((prev) => {
      const next = runningRcViewer();
      return prev?.pid === next?.pid && prev?.window === next?.window ? prev : next;
    });
    read();
    const timer = setInterval(read, TIMING.activityPoll);
    return () => clearInterval(timer);
  }, [visible]);
  return rcViewer;
}

/** What the Remote Control Viewer's row above the list says: its name, and how many sessions wait for the user. */
export function rcViewerRowLabel(waiting: number): string {
  return `⊞ Remote Control Viewer${waiting > 0 ? ` · ⚠${waiting} waiting` : ""}`;
}

/**
 * The Remote Control Viewer's row (`label`) above the list (`children`), always its top row: a badge like ↓ more ↓, inverse while
 * `selected`; a click on it calls `onOpen`. The list below gets the rest of the area.
 */
function RcViewerRow({ label, selected, onOpen, children }: { label: string; selected: boolean; onOpen: () => void; children: ReactNode }) {
  const area = useContext(AreaContext);
  const width = columnWidthOf(area);
  useMouse((e) => {
    if (e.kind === "click" && e.y === area.y && e.x >= area.x && e.x < area.x + area.width) onOpen();
  });
  // While sessions wait, the ⚠ of its label goes on and off like theirs.
  const off = useBlinkOff(label.includes("⚠"));
  if (off) label = label.replace("⚠", " ");
  const text = ` ${label} `;
  const indent = " ".repeat(Math.max(0, Math.floor((width - stringWidth(text)) / 2)));
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        {selected ? (
          <Text inverse bold>
            {(indent + text).padEnd(width)}
          </Text>
        ) : (
          centredBadge(label, width)
        )}
      </Text>
      <AreaContext.Provider value={{ ...area, y: area.y + 1, height: Math.max(1, area.height - 1) }}>{children}</AreaContext.Provider>
    </Box>
  );
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
  return <Text>{centredBadge("⤓ import sessions…", columnWidthOf(area))}</Text>;
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

export function SessionsView({ cwd, activePath, layout, visible, active, onModal, onTyping, onPair, paired, onPairStarted, onDetach, accountRequest }: Props) {
  const { listWidth, previewWidth, bodyHeight, headerHeight = bodyHeight, listHeight = bodyHeight } = layout;
  const focused = useFocused();
  const [isDoubleClick] = useState(() => doubleClicks());
  const copy = useClipboard();
  const [sessionsFolders] = useSetting("sessionsFolders");
  const [sessionsAccounts] = useSetting("sessionsAccounts");
  const [sessionsBackground] = useSetting("sessionsBackground");
  const [sessionsRemote] = useSetting("sessionsRemote");
  const [remoteApi] = useSetting("remoteApi");
  const [remoteControl] = useSetting("remoteControl");
  const [separators] = useSetting("dateSeparators");
  const [pinnedSessions] = useSetting("pinnedSessions");
  const [accountColor] = useSetting("accountColor");
  const [accountAvatar] = useSetting("accountAvatar");
  const range = useListRange("sessionsRange");
  // The other accounts signed in here: a session can continue in one of them, and the list may show theirs.
  const accountState = useAccountState();
  const others = otherAccounts(accountState.accounts);
  const ownAccount = accountState.accounts.find((a) => otherAccounts([a], accountState.own).length === 0);
  // With the other accounts, every row gets a bar in its account's colour and the header names the account.
  // What the list shows (a opens the dialog): the project folders, the accounts, the background sessions.
  const ownDir = claudeDir();
  const shownFilter = sessionFilter({ sessionsFolders, sessionsAccounts, sessionsBackground, sessionsRemote }, ownDir, others.map((a) => a.dir));
  const [filterOpen, setFilterOpen] = useState(false);
  const all = shownFilter.folders !== "this";
  const ownChosen = shownFilter.accounts[0] === ownDir;
  const foreignKey = shownFilter.accounts.filter((dir) => dir !== ownDir).join("\n");
  const withAccounts = foreignKey !== "";
  const foreign = useMemo(() => (foreignKey ? foreignKey.split("\n") : []), [foreignKey]);
  // The own folder is read for the active session also while its account is not chosen, then only this project's.
  const { sessions: read, progress, complete, refresh } = useSessions(cwd, visible, all, range.since, foreign, ownChosen && all);
  const running = useRunning(visible, foreign);
  const viewers = useSessionViewers(visible);
  /** The viewers of `s` that run, the newest last. */
  const viewersFor = (s: SessionSummary) =>
    viewersOf(viewers, s.remote ? { remoteId: s.id } : { ids: [s.id, ...(s.continues ?? [])], configDir: s.account ?? claudeDir() });
  const viewedCount = (s: SessionSummary) => (trashOpen ? 0 : viewersFor(s).length);
  // Remote Control sessions (claude.ai), unless one of this machine's sessions is the same: that one then shows ⇄.
  const remoteRead = useRemoteSessions(visible, remoteApi && shownFilter.remote !== "hide");
  // The Remote Control Viewer's row above the list: whether it runs, and how many sessions of every account wait for the user.
  const rcViewer = useRcViewerRuns(visible);
  const otherDirs = useMemo(() => others.map((a) => a.dir), [others.map((a) => a.dir).join("\n")]);
  const everyRunning = useRunning(visible, otherDirs);
  const waitingCount =
    [...everyRunning.values()].filter((r) => r.activity === "waiting").length + remoteRead.sessions.filter((r) => r.remote?.workerStatus === "requires_action" || r.remote?.pending).length;
  // The row has the selection (↑ from the top of the list, ↓ back): Enter opens the Remote Control Viewer.
  const [rcViewerSelected, setRcViewerSelected] = useState(false);
  const { merged, connected, twins } = useMemo(() => {
    if (!read) return { merged: read, connected: new Set<string>(), twins: new Map<string, SessionSummary>() };
    return mergeRemote(withNames(read, running), remoteRead.sessions);
  }, [read, remoteRead.sessions, running]);
  const activeId = activePath ? basename(activePath, ".jsonl") : undefined;
  /** The viewer's own session; another account's never is, even under the same id. */
  const isActive = (s: SessionSummary) => !s.account && s.id === activeId;
  const accountOf = (s: SessionSummary): Account | undefined => (s.account ? others.find((a) => a.dir === s.account) : ownAccount);
  const barColor = (s: SessionSummary): AccountColorName | "gray" => {
    const account = accountOf(s);
    return account ? barColorOfAccount(account, accountState, accountColor) : "gray";
  };
  const avatarOf = (s: SessionSummary): string | undefined => {
    const account = accountOf(s);
    return account && avatarOfAccount(account, accountState, accountAvatar);
  };
  // With an avatar for any of the accounts listed, the rows start with the avatar instead of the bar, all as wide as the widest.
  const leadWidth = withAccounts
    ? Math.max(1, ...[ownAccount, ...others].map((a) => (a ? (avatarOfAccount(a, accountState, accountAvatar) ?? "") : "")).map((t) => (t ? stringWidth(t) + 2 : 0)))
    : 0;
  const accountLead = (s: SessionSummary) => {
    const color = barColor(s);
    const avatar = avatarOf(s);
    if (leadWidth === 1) return <Text color={color}>▌</Text>;
    if (!avatar) return <Text color={color}>{"▌".padEnd(leadWidth)}</Text>;
    const text = ` ${avatar} `;
    const pad = " ".repeat(Math.max(0, leadWidth - stringWidth(text)));
    // On the account's colour as in the top bar; where its colour is off, in gray.
    return color === "gray" ? (
      <Text color="gray">{text + pad}</Text>
    ) : (
      <Text>
        <Text color={ACCOUNT_COLORS[color]} backgroundColor={color}>
          {text}
        </Text>
        {pad}
      </Text>
    );
  };
  // The sessions last worked in during the range (see lastActive); the active and running ones also when that was before it.
  // Of those, the ones the filter chooses; the active session always.
  const filterKey = JSON.stringify(shownFilter);
  const sessions = useMemo(() => {
    const since = range.since;
    if (!merged) return merged;
    return merged.filter((s) => {
      if (isActive(s)) return true;
      if (!passesFilter(s, shownFilter, ownDir, cwd, backgroundOf(s, running.get(sessionKey(s))))) return false;
      const at = lastActive(s);
      return since === undefined || !at || Date.parse(at) >= since || running.has(sessionKey(s));
    });
  }, [merged, range.since, activeId, running, filterKey]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashRead, setTrash] = useState<TrashEntry[]>([]);
  // The trash holds this account's sessions: the filter's folders and background sessions apply, its accounts do not.
  const trash = useMemo(
    () => trashRead.filter((e) => passesFilter(e.summary, { ...shownFilter, accounts: [ownDir] }, ownDir, cwd, e.summary.background)),
    [trashRead, filterKey],
  );
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
    notify: (message) => notify(message),
    onCopied: () => refresh(),
  });
  // The app's progress dialog shows the export, the import or the wait for a Claude Code to attach to.
  const progressOpen = useProgressOpen();
  // The dialog listing the selected session's attachments (o).
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  // Prompts and interrupts for remote sessions (setting remoteControl).
  // A request that the list no longer names was answered elsewhere.
  const remoteCtl = useRemoteControl(layout, (message) => notify(message), (id, requestId) => {
    const s = remoteRead.sessions.find((r) => r.id === id);
    return s ? s.remote?.pending?.requestId === requestId : undefined;
  });
  const dialogOpen =
    attachmentsOpen ||
    remoteCtl.open || confirmation !== undefined || choice !== undefined || renaming !== undefined || exporting !== undefined || importFrom !== undefined || run !== undefined || flow.open || progressOpen || filterOpen;
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
    text: (e) => (isSession(e) ? sessionText(e, folderGone(e), withAccounts ? accountOf(e)?.email : undefined, backgroundOf(e, running.get(sessionKey(e)))) : { list: "", details: "" }),
    selected: sessionFound >= 0 ? sessionFound : sessionList.length - 1,
    select: (i) => select(i),
    reversed: true,
    layout,
    enabled: !trashOpen,
    onTyping,
    keep: (e) => !isSession(e),
    marked: (e) => isSession(e) && favorites.isMarked(sessionKey(e)),
    pin: pinnedSessions ? (e) => isSession(e) && (isActive(e) || running.has(sessionKey(e)) || e.remote?.workerStatus === "requires_action") : undefined,
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
  // A remote session's events, read while it is selected; until then the list's data.
  const remoteDetail = useRemoteDetail(session, visible);
  const viewed = remoteDetail ?? session;
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
    if (!viewed) return [];
    const state = stateOf(viewed);
    const activity = state === "active" || state === "running" ? running.get(sessionKey(viewed))?.activity : undefined;
    const account = withAccounts && !trashOpen ? sessionAccountLines(accountOf(viewed), barColor(viewed), !viewed.account) : [];
    return fitHeader(
      sessionHeader(
        viewed,
        state,
        previewWidth,
        entry?.deletedAt,
        activity,
        folderGone(viewed),
        trashOpen ? undefined : transferOf(viewed),
        account,
        backgroundLine(backgroundOf(viewed, running.get(sessionKey(viewed))), running.get(sessionKey(viewed))) ?? remoteLine(viewed),
        trashOpen ? undefined : viewedLine(viewersFor(viewed).length),
      ),
      headerHeight,
    );
  }, [viewed, activeId, running, viewers, trashOpen, entry, previewWidth, headerHeight, transfers, withAccounts, accountState, accountColor]);
  const { lines, attachmentRows } = useMemo(() => {
    const rows = new Map<number, number>();
    // A remote session has no transcript on this machine.
    const lines = viewed ? sessionLines(viewed, cwd, previewWidth, separators, viewed.remote ? undefined : transcriptLocation(viewed, entry), rows) : [];
    return { lines, attachmentRows: rows };
  }, [viewed, cwd, previewWidth, separators, entry]);
  // What came with the prompts and what tools returned; `o` lists them, a click on one's line opens it.
  const attachments = viewed && !viewed.remote ? (viewed.attachments ?? []) : [];
  const viewport = bodyHeightBelow(header, bodyHeight);
  const scroll = positions.scroll(session && sessionKey(session), lines.length, viewport);

  useEffect(() => onModal?.(dialogOpen), [dialogOpen]);

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
  /** Opens one of the selected session's attachments; a trashed session's transcripts are read where the trash keeps them. */
  const openAttachment = (item: AttachmentItem | undefined) => {
    if (!item) return;
    let file: string | undefined;
    try {
      file = attachmentFile(item, (t) => entry?.items.find((i) => i.from === t)?.to ?? t);
    } catch (err) {
      return notify(`could not read ${attachmentTitle(item)}: ${(err as Error).message}`);
    }
    if (!file) return notify(`${attachmentTitle(item)} is no longer available`);
    openInDefaultApp(file);
    notify(`opened ${attachmentTitle(item)}`);
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
      rename: renamePlan(renameSituationOf(s)),
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
      viewers: viewersFor(s).length,
      rcViewer: { runs: rcViewer !== undefined, listed: rcViewerLists(s) },
      folder: tilde(dir),
      // A session the Claude Code daemon runs is attached to, not resumed.
      command: claude?.kind === "bg" && claude.jobId ? `claude attach ${claude.jobId}` : resumeCommand(s),
    };
    return { situation, claude, dir };
  };

  /** Where `s` stands for renaming it: its transcript, the Claude Code it runs in, its session on claude.ai. */
  const renameSituationOf = (s: SessionSummary): RenameSituation => {
    const twin = s.remote ? s : twins.get(s.id);
    return {
      local: s.remote ? undefined : { path: s.path, id: s.id },
      running: s.remote ? undefined : running.get(sessionKey(s)),
      remote: twin && { id: twin.id, connected: twin.remote?.connectionStatus === "connected" },
      control: remoteControl,
      dir: s.account,
    };
  };

  /** The head every dialog about `s` starts with; where it stands as Enter sees it, unless `state` says. */
  const headFor = (s: SessionSummary, state?: HeadState) => {
    const dir = s.cwd ?? cwd;
    const stands: HeadState = state ?? (paired && isActive(s) ? "current" : running.has(sessionKey(s)) ? "active" : "inactive");
    return sessionHead(s, { accounts: accountState, accountColor }, { dir, gone: !existsSync(dir), state: stands });
  };

  /** Enter: asks what to do with the session (`sessionOptions`), with the usual choice selected. */
  const start = (s: SessionSummary) => {
    if (s.remote) return startRemote(s);
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

  /**
   * Enter on a remote session: with steer remote, what fits what it does first (a prompt, interrupting it), then
   * a viewer of its own and its address.
   */
  const startRemote = (s: SessionSummary) => {
    const control = remoteControl ? remoteOptions(s.remote?.workerStatus, s.remote?.pending) : [];
    const watching = viewersFor(s).length;
    const plan = renamePlan(renameSituationOf(s));
    const options: ChoiceOption[] = [
      ...control,
      ...viewerOptions(watching, detectTerminal() !== undefined, { control: remoteControl }),
      { id: "rename", label: "Rename it", detail: plan.detail, disabled: plan.disabled },
      { id: "copy", label: "Copy its address", detail: remoteUrl(s.id) },
      rcViewerOption({ runs: rcViewer !== undefined, listed: true }, detectTerminal() !== undefined),
    ];
    setChoice({
      title: "What to do with this session?",
      lines: [truncate(sessionTitle(s), 56), span(s.start, s.end), "remote: it runs on another machine, read from claude.ai"].filter(Boolean),
      options,
      initial: Math.max(0, options.findIndex((o) => !o.disabled)),
      onChoose: (id: string) => {
        setChoice(undefined);
        if (id === "viewer") return openViewer(s);
        if (id === "viewer-front") return bringViewer(s);
        if (id === "rcViewer") return openRcViewerFor(s);
        if (id === "rename") return setRenaming(s);
        if (id === "copy") return act("copy", s, cwd, undefined, remoteUrl(s.id));
        remoteCtl.act(id as RemoteAction, { id: s.id, title: sessionTitle(s), workerStatus: s.remote?.workerStatus, pending: s.remote?.pending });
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
      case "viewer":
        return openViewer(s);
      case "viewer-front":
        return bringViewer(s);
      case "rcViewer":
        return openRcViewerFor(s);
      case "folder":
        return openInDefaultApp(dir);
      case "copy":
        return void copy(command).then(
          () => notify(`copied: ${command}`),
          (err: Error) => notify(`copy failed: ${err.message}`),
        );
    }
  };
  /** Whether the Remote Control Viewer lists `s`: it runs, or was active today; a remote one while claude.ai lists it. */
  const rcViewerLists = (s: SessionSummary) => {
    if (s.remote || running.has(sessionKey(s))) return true;
    const at = lastActive(s);
    return at !== undefined && Date.parse(at) >= rangeStart("today")!;
  };
  /**
   * Opens the Remote Control Viewer in its window (or brings the one that runs to the front), with `s` selected if given. Without a
   * terminal to open it in, copies `cco rc-viewer`.
   */
  const openRcViewerFor = (s?: SessionSummary) => {
    const select: RcViewerSelect | undefined = !s ? undefined : s.remote ? { id: s.id, remote: true } : { id: s.id, configDir: s.account ?? claudeDir() };
    const opened = openRcViewer(runningRcViewer(), select);
    if (opened) return notify(opened);
    void copy("cco rc-viewer").then(
      () => notify("no Windows Terminal or tmux: copied cco rc-viewer, run it in a terminal of its own"),
      () => notify("no Windows Terminal or tmux: run cco rc-viewer in a terminal of its own"),
    );
  };
  /**
   * Opens a viewer of `s` in a new window: its chat, live, with a prompt line, and its own settings; any number per
   * session. Without a terminal to open it in, copies the command.
   */
  const openViewer = (s: SessionSummary) => {
    const target: ViewerTarget = s.remote ? { remoteId: s.id } : { sessionId: s.id, cwd: s.cwd ?? cwd, configDir: s.account };
    const opened = openSessionViewer(target, truncate(`${s.remote ? "◈ " : ""}${sessionTitle(s)}`, 30), viewerWindow());
    if (opened) return notify(opened);
    const command = viewerCommand(target);
    void copy(command).then(
      () => notify(`no Windows Terminal or tmux: copied ${command}`),
      (err: Error) => notify(`copy failed: ${err.message}`),
    );
  };
  /** Brings the viewer of `s` opened last to the front. */
  const bringViewer = (s: SessionSummary) => {
    const last = viewersFor(s).filter((o) => o.window).at(-1);
    if (!last?.window) return notify("its viewers were not opened by cco: their window is unknown");
    notify(focusSessionViewer(last.window) ? "its viewer is in front" : "no Windows Terminal or tmux");
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

  /** Renames the session as `renamePlan` says (its transcript, its Claude Code, claude.ai); the next scan shows it. */
  const rename = (s: SessionSummary, title: string) => {
    setRenaming(undefined);
    notify(`renaming: ${title}…`);
    void renameAnywhere(renameSituationOf(s), title).then(notify, (err: Error) => notify(`rename failed: ${err.message}`)).finally(refresh);
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
  /** The trash is read for the list's folders: this project's, or all (other folders: the filter leaves this one out). */
  const trashScope = all ? undefined : projectSlug(cwd);
  const folderText = { this: "of this project", other: "of the other projects", all: "of all projects" }[shownFilter.folders];
  // The trash follows a change of the folders right away; the list with the next scan.
  const trashFolders = useRef(all);
  useEffect(() => {
    if (trashFolders.current === all) return;
    trashFolders.current = all;
    if (trashOpen) setTrash(listTrash(trashScope));
  }, [all]);
  const applyFilter = (next: SessionFilter) => {
    setFilterOpen(false);
    updateSettings(filterSettings(next, ownDir, others.map((a) => a.dir)));
  };
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
      lines: [countHead(trash.length, "session", folderText), "", "They will be deleted for good.", "This can't be undone."],
      danger: true,
      // Only those shown: the filter may hide some of the trash.
      onConfirm: () => attempt(() => trash.forEach((e) => purgeSession(e.slug, e.id, cwd)), "trash emptied"),
    });
  };

  /** The marked sessions, else `s`, with the form for the options. */
  const askExport = (s: SessionSummary) => {
    // Only this account's sessions: another account's are not exported from here.
    const marked = (sessions ?? []).filter((m) => !m.account && !m.remote && favorites.isMarked(m.id));
    const targets = marked.length ? marked : [s];
    setExporting({ sessions: targets, opts: readExportOptions(), lines: exportLines(targets) });
  };
  const askImport = () => setImportFrom(newestExport() ?? "");
  /** Asks, then moves a session whose folder is gone into this project folder. */
  const askMove = (s: SessionSummary) =>
    setConfirmation({
      title: "Move this session to this project?",
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
      ...(one ? headFor(one) : [countHead(targets.length, "marked session", folderText)]),
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

  // The selection is in the list's top row: ↑ goes on to the Remote Control Viewer's row above it.
  const atListTop = filter.pinned ? filter.pinned.row === 0 : screenOrder(list.length, filter.shown, true)[0] === index;

  useInput(
    (input, key) => {
      if (filter.handleKey(input, key)) return;
      if (input === "T") return toggleTrash(!trashOpen);
      if (input === "a") return setFilterOpen(true);
      // k: the Remote Control Viewer, a window that watches every session (cco rc-viewer); the one that runs comes to the front.
      if (input === "k" && !trashOpen) return openRcViewerFor();
      // The Remote Control Viewer's row above the list: ↑ from the list's top row reaches it, ↓ goes back, Enter opens the Remote Control Viewer.
      if (!trashOpen && rcViewerSelected) {
        if (key.return) return openRcViewerFor();
        if (key.downArrow && !key.shift && !key.ctrl) return setRcViewerSelected(false);
        if ((key.upArrow && !key.ctrl) || key.home || key.pageUp) return;
        setRcViewerSelected(false);
      } else if (!trashOpen && key.upArrow && !key.shift && !key.ctrl && atListTop) return setRcViewerSelected(true);
      if (input === "o" && session) return attachments.length ? setAttachmentsOpen(true) : notify(session.remote ? "a remote session's attachments are on claude.ai" : "no attachments in this session");
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
        if ((input === "d" || key.delete) && session) return session.remote ? notify("a remote session lives on claude.ai: archive it there") : session.account ? notify(OWN_ONLY) : askDelete(session);
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
  if (!trashOpen && rcViewerSelected)
    preview = (
      <Text dimColor>
        {[
          "The Remote Control Viewer: one window with the sessions of every project and account that run or ran today, grouped by what they need (waiting for you, working, idle, ended), beside the selected one's turns and chat.",
          "",
          rcViewer ? "Enter, k or a click brings it to the front." : "Enter, k or a click opens it in a window of its own (Windows Terminal or tmux).",
          waitingCount > 0 ? `\n${waitingCount === 1 ? "1 session waits" : `${waitingCount} sessions wait`} for you.` : "",
        ].join("\n")}
      </Text>
    );
  else if (trashOpen && !session) preview = <Text dimColor>The trash is empty.</Text>;
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
        onLineClick={(i) => {
          const at = attachmentRows.get(i);
          if (at !== undefined) openAttachment(attachments[at]);
        }}
      />
    );

  const footer = trashOpen
    ? [
        { text: "↑↓ session", priority: 4 },
        { text: "PgUp/Dn scroll", priority: 1 },
        { text: "u restore", priority: 4 },
        ...(attachments.length > 0 ? [{ text: "o attachments", priority: 2 }] : []),
        { text: "x delete", priority: 3 },
        { text: "X empty", priority: 2 },
        { text: "a filter", on: filterIsSet(shownFilter, ownDir), priority: 2 },
        { text: "T trash", on: true },
      ]
    : [
        { text: "↑↓ session", priority: 4 },
        { text: "PgUp/Dn scroll", priority: 1 },
        ...markFooter(favorites.isMarked(session && sessionKey(session)), markedCount),
        ...filter.footer,
        {
          text: rcViewerSelected
            ? "↵ Remote Control Viewer"
            : onLoadMore
            ? "↵ load more"
            : onImport
              ? "↵ import"
              : session?.remote
                ? "↵ open…"
                : session
                ? enterLabel(situationOf(session).situation)
                : "↵ start",
          priority: 3,
        },
        { text: "c copy resume", priority: 2 },
        ...(attachments.length > 0 ? [{ text: "o attachments", priority: 2 }] : []),
        { text: "d delete", priority: 2 },
        ...(lastTrashed ? [{ text: "u undo", priority: 3 }] : []),
        { text: "a filter", on: filterIsSet(shownFilter, ownDir), priority: 2 },
        { text: "T trash", priority: 2 },
        { text: "k Remote Control Viewer", priority: 1 },
        { text: "1-6/tab view", priority: 1 },
      ];

  // The list; above it, outside the trash, the Remote Control Viewer's row.
  const sessionsList = (
    <List
      reversed={reversed}
      onPick={(i) => {
        setRcViewerSelected(false);
        select(i);
      }}
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
      height={trashOpen ? listHeight : Math.max(1, listHeight - 1)}
      empty={trashOpen ? "Trash is empty" : (filter.empty ?? (sessions ? "No sessions" : "…"))}
      itemKey={entryId}
      time={listedAt}
      // The account's bar stays in its colour on the selected row too.
      lead={withAccounts ? (s) => (isSession(s) ? accountLead(s) : undefined) : undefined}
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
        // Ran with claude -p, the SDK or the daemon.
        const background = backgroundOf(s, running.get(sessionKey(s))) !== undefined;
        // Read from claude.ai (◈), or of this machine and connected to it (⇄).
        const waits = s.remote?.workerStatus === "requires_action";
        const remoteMark = s.remote ? `${REMOTE_MARK} ` : connected.has(s.id) ? `${CONNECTED_MARK} ` : "";
        // Images and PDFs that came with its prompts or from its tools.
        const media = mediaOf(s);
        const mediaMark = media > 0 ? `${MEDIA_MARK}${media} ` : "";
        // Dynamic workflows Claude started there.
        const flows = s.workflows?.length ?? 0;
        const workflowMark = flows > 0 ? `${WORKFLOW_MARK}${flows > 1 ? flows : ""} ` : "";
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
            {/* A remote session waits for an answer (⚠), its ◈ blinks while Claude works there. */}
            {waits && <SessionMarker symbol="⚠ " activity="waiting" />}
            {remoteMark &&
              (s.remote?.workerStatus === "running" ? (
                <SessionMarker symbol={remoteMark} activity="busy" color="cyan" />
              ) : (
                <Text color="cyan">{remoteMark}</Text>
              ))}
            {/* Open in windows of their own (◎, ◎2). */}
            {viewedCount(s) > 0 && <Text color="blue">{`${VIEWED_MARK}${viewedCount(s) > 1 ? viewedCount(s) : ""} `}</Text>}
            {mediaMark && <Text color="cyan">{mediaMark}</Text>}
            {workflowMark && <Text color="magenta">{workflowMark}</Text>}
            {/* Ran in the background: before the project name. */}
            {background && <Text dimColor={!isSelected}>{`${BACKGROUND_MARK} `}</Text>}
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
                    (withAccounts ? leadWidth + 1 : 0) -
                    (marked ? 2 : 0) -
                    (badge || gone ? 2 : 0) -
                    (moved ? 2 : 0) -
                    (remoteMark ? 2 : 0) -
                    (waits ? 2 : 0) -
                    (background ? 2 : 0) -
                    mediaMark.length -
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
  );

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
            {remoteRead.error && !trashOpen && <Text color="yellow">{` · ${remoteRead.error}`}</Text>}
            {session && !progress && ` · ${scroll.position}`}
            {!trashOpen && markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
          </Text>
        }
        list={
          trashOpen ? (
            sessionsList
          ) : (
            <RcViewerRow label={rcViewerRowLabel(waitingCount)} selected={rcViewerSelected && focused} onOpen={() => openRcViewerFor()}>
              <FocusContext.Provider value={focused && !rcViewerSelected}>{sessionsList}</FocusContext.Provider>
            </RcViewerRow>
          )
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
          lines={renaming.remote ? [truncate(sessionTitle(renaming), 56)] : headFor(renaming)}
          title={sessionTitle(renaming)}
          how={renamePlan(renameSituationOf(renaming)).detail}
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
      {attachmentsOpen && (
        <AttachmentsDialog layout={layout} items={attachments} of="session" onOpen={openAttachment} onClose={() => setAttachmentsOpen(false)} />
      )}
      {flow.element}
      {remoteCtl.element}
      {filter.dialog}
      {filterOpen && (
        <SessionFilterDialog
          layout={layout}
          initial={shownFilter}
          folderName={basename(cwd) || cwd}
          // The trash holds this account's sessions only.
          accounts={trashOpen ? [] : filterAccounts(accountState.accounts, ownDir)}
          remote={remoteApi}
          onApply={applyFilter}
          onClose={() => setFilterOpen(false)}
        />
      )}
    </>
  );
}
