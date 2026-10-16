import { Box, Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RcViewerSelect } from "../rcViewer/registry.js";
import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { barColorOfAccount, type Account } from "../account.js";
import { otherAccounts } from "../accountContinue.js";
import { formatAge, RC_VIEWER_GROUPS, rcViewerEntries, nextWaiting, runningStandIn, updateFresh, type FreshIdle, type RcViewerEntry, type RcViewerState, type SeenStates } from "../rcViewer/state.js";
import { rcViewerOptions, type RcViewerAction } from "../rcViewer/actions.js";
import { detectTerminal, focusSessionViewer, openSessionViewer, resumeInNewWindow, viewerCommand, type ViewerTarget } from "../open.js";
import { sendInterrupt, sendPrompt, sendResponse } from "../remote/api.js";
import { describeRemoteError, remotePath, remoteUrl } from "../remote/index.js";
import { viewersOf, viewerWindow } from "../sessionViewers.js";
import { switchToSession } from "../switchSession.js";
import { rangeStart, readSettings, updateSettings, type ColumnWidth, type ListWidth } from "../settings.js";
import { TIMING } from "../timing.js";
import { claudeDir, inClaudeDir, projectDir } from "../transcript/locate.js";
import type { SessionSummary } from "../transcript/sessions.js";
import { isListFold } from "../settings.js";
import { ChatView } from "./ChatView.js";
import { ChoiceDialog, type Choice } from "./ChoiceDialog.js";
import { dayOf } from "./days.js";
import { FocusContext, useFocused } from "./focus.js";
import { EntryText, List, ScreenAsideContext, shorter, truncate, type FooterItem, type Layout } from "./layout.js";
import { stepFold, toggleFold, UNFOLDED, type FoldState } from "./listFold.js";
import { useMouse } from "./mouse.js";
import { SessionComposer, type PromptChannel } from "./SessionComposer.js";
import { projectName, resumeCommand, SessionMarker } from "./SessionsView.js";
import { sessionHead, sessionTitle } from "./sessionHead.js";
import { useTerminalTitle } from "./title.js";
import { useAccountState } from "./useAccount.js";
import { useClipboard } from "./useClipboard.js";
import { useLocalPrompt } from "./useLocalPrompt.js";
import { useRemoteTranscript } from "./useRemoteTranscript.js";
import { mergeRemote, sessionKey, useRemoteSessions, useRunning, useSessions, useSessionViewers } from "./useSessionData.js";
import { useSetting } from "./useSetting.js";
import { useTranscript } from "./useTranscript.js";

/** The Remote Control Viewer's columns, left to right: `←` and `→` move the keys between them. */
export type RcViewerColumn = "sessions" | "turns" | "chat";
const COLUMNS: RcViewerColumn[] = ["sessions", "turns", "chat"];

interface Props {
  /** The layout of the turns and the chat, beside the sessions column (`rcViewerLayout`). */
  layout: Layout;
  /** The sessions column's width (`rcViewerLayout`'s `aside`). */
  aside: number;
  /** The Remote Control Viewer is shown (its data is read only then). */
  visible: boolean;
  /** The view takes keys. */
  active: boolean;
  onTyping?: (typing: boolean) => void;
  onModal?: (open: boolean) => void;
  /** A short message in the bottom row (the width after `<` or `>`). */
  notify: (text: string) => void;
  /** A session to select, once per `at`: as soon as the list has it. */
  request?: RcViewerSelect & { at: number };
  /**
   * Whether the view takes Tab and i itself (the chat column, where they give the prompt line the keys): the Remote Control Viewer's
   * app then leaves them alone.
   */
  onClaimKeys?: (claims: boolean) => void;
}

/** The sessions of the accounts other than this one, among those found. */
const foreignDirs = (accounts: Account[]) => otherAccounts(accounts).map((a) => a.dir);

/** The id in a `sessionKey` (another account's carries its folder before a `|`). */
const idOfKey = (key: string) => key.slice(key.lastIndexOf("|") + 1);
const accountOfKey = (key: string) => (key.includes("|") ? key.slice(0, key.lastIndexOf("|")) : undefined);

const samePath = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** Whether `s` is the session `request` asks for: a remote one by its id, one of this machine by an id of its chain in its config folder. */
export function matchesRequest(s: SessionSummary, request: RcViewerSelect): boolean {
  if (request.remote || s.remote) return Boolean(request.remote && s.remote && s.id === request.id);
  if (s.id !== request.id && !(s.continues ?? []).includes(request.id)) return false;
  return !request.configDir || samePath(s.account ?? claudeDir(), request.configDir);
}

/**
 * The marker of a session in the Remote Control Viewer's list: ⚠ waits (blinking on and off), ● works (blinking bright and dim) or is
 * idle (blinking on and off while it just finished, `fresh`), ∅ ended; ◈ for a remote one.
 */
function RcViewerMarker({ entry, fresh }: { entry: RcViewerEntry; fresh: boolean }) {
  const { state, session } = entry;
  if (state === "waiting") return <SessionMarker symbol="⚠" activity="waiting" />;
  if (state === "ended") return <Text dimColor>∅</Text>;
  const symbol = session.remote ? "◈" : "●";
  return <SessionMarker symbol={symbol} activity={state === "busy" ? "busy" : "idle"} color={session.remote ? "cyan" : "green"} flash={state === "idle" && fresh} />;
}

/**
 * The Remote Control Viewer (`cco rc-viewer`): the sessions that run or ran today, of every project and account and claude.ai
 * (setting remote API), grouped by what they need (waiting, working, idle, ended); beside them the selected session's
 * turns and the chat of the selected turn, live. `←` and `→` move the keys between the three columns.
 */
export function RcViewerView({ layout: full, aside, visible, active, onTyping, onModal, notify, request, onClaimKeys }: Props) {
  const focused = useFocused();
  const [column, setColumn] = useState<RcViewerColumn>("sessions");
  const accountState = useAccountState();
  const [accountColor] = useSetting("accountColor");
  const [remoteApi] = useSetting("remoteApi");
  const [remoteControl] = useSetting("remoteControl");
  const copy = useClipboard();
  const foreignKey = foreignDirs(accountState.accounts).join("\n");
  const foreign = useMemo(() => (foreignKey ? foreignKey.split("\n") : []), [foreignKey]);
  // Today's sessions: a new day starts the list afresh on the next read.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TIMING.activityPoll);
    return () => clearInterval(timer);
  }, []);
  const day = dayOf(now);
  const dayStart = useMemo(() => rangeStart("today", new Date(now))!, [day]);
  const { sessions: read } = useSessions(process.cwd(), visible, true, dayStart, foreign);
  const running = useRunning(visible, foreign);
  const remote = useRemoteSessions(visible, remoteApi);
  // Sessions that run but were not read (no prompt yet, nothing written today) stand in with what their Claude Code tells.
  const seen = useRef<SeenStates>(new Map());
  const { entries, twins } = useMemo(() => {
    const { merged, twins } = mergeRemote(read ?? [], remote.sessions);
    const known = new Set(merged.map(sessionKey));
    const standIns: SessionSummary[] = [];
    for (const [key, run] of running) {
      if (known.has(key) || !run.cwd) continue;
      const account = accountOfKey(key);
      const id = idOfKey(key);
      const dir = account ? inClaudeDir(account, () => projectDir(run.cwd!)) : projectDir(run.cwd);
      standIns.push(runningStandIn(id, run, join(dir, `${id}.jsonl`), account));
    }
    return { entries: rcViewerEntries([...merged, ...standIns], running, sessionKey, seen.current, now, dayStart), twins };
  }, [read, remote.sessions, running, now, dayStart]);

  // Kept by key: the entries move between the groups as their sessions change.
  const [selectedKey, setSelectedKey] = useState<string>();
  const lastIndex = useRef(0);
  const found = selectedKey === undefined ? -1 : entries.findIndex((e) => e.key === selectedKey);
  const index = found >= 0 ? found : Math.min(lastIndex.current, Math.max(0, entries.length - 1));
  lastIndex.current = index;
  const entry = entries[index];
  // A session asked for (Sessions, /cco:rc-viewer) is selected once the list has it, the keys in the sessions column.
  const answered = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!request || answered.current === request.at) return;
    const asked = entries.find((e) => matchesRequest(e.session, request));
    if (!asked) return;
    answered.current = request.at;
    setSelectedKey(asked.key);
    setColumn("sessions");
  }, [request, entries]);
  const select = (i: number) => {
    const next = entries[Math.max(0, Math.min(entries.length - 1, i))];
    if (next) setSelectedKey(next.key);
  };

  // Sessions that just finished blink until seen: selected while the Remote Control Viewer has the focus, or after a while.
  const [fresh, setFresh] = useState<FreshIdle>(new Map());
  const states = useRef<Map<string, RcViewerState>>(new Map());
  useEffect(() => {
    setFresh((f) => updateFresh(f, states.current, entries, Date.now(), entry?.key, focused, { long: TIMING.freshIdle, short: TIMING.freshSelected }));
    states.current = new Map(entries.map((e) => [e.key, e.state]));
  }, [entries]);
  useEffect(() => {
    const seen = entry && fresh.get(entry.key);
    if (!focused || !seen || seen.short) return;
    setFresh((f) => {
      const next = new Map(f);
      next.delete(entry.key);
      return next;
    });
  }, [entry?.key, focused, fresh]);
  const isFresh = (e: RcViewerEntry) => (fresh.get(e.key)?.until ?? 0) > now;

  // The selected session's turns: a local one from its transcript, a remote one from claude.ai.
  const session = entry?.session;
  const local = useTranscript(session && !session.remote ? session.path : undefined);
  // A session of this machine connected to claude.ai (⇄): what it waits for is read there, and with steer remote on,
  // the prompt line sends there.
  const bridge = session && !session.remote && !session.account ? twins.get(session.id) : undefined;
  const remoteRead = useRemoteTranscript(session?.remote ? session.id : bridge?.id);
  const transcript = session?.remote ? remoteRead : local;
  const path = !session ? undefined : session.remote ? remotePath(session.id) : (local.file ?? session.path);
  const live = entry !== undefined && (entry.state === "busy" || entry.state === "waiting");

  // The prompt line below the chat writes to the selected session: typed into the Claude Code that runs one of this
  // machine, sent through claude.ai for a remote one. The chat column's Tab or i give it the keys, Esc or Tab take them back.
  const [composing, setComposing] = useState(false);
  const [composerRows, setComposerRows] = useState(3);
  const typingInComposer = composing && column === "chat" && session !== undefined;
  const localChannel = useLocalPrompt(session && !session.remote ? entry?.running : undefined, typingInComposer);
  const remoteId = session?.remote ? session.id : bridge && remoteControl ? bridge.id : undefined;
  const remoteChannel = useMemo((): PromptChannel | undefined => {
    if (!remoteId) return undefined;
    const readable = (p: Promise<void>) => p.catch((err) => Promise.reject(new Error(describeRemoteError(err))));
    return {
      blocked: remoteControl ? undefined : "steer remote is off (Settings of a viewer)",
      send: (text) => readable(sendPrompt(remoteId, text)),
      interrupt: () => readable(sendInterrupt(remoteId)),
      respond: (requestId, response) => readable(sendResponse(remoteId, requestId, response)),
    };
  }, [remoteId, remoteControl]);
  // An ended session of this machine continues from the Enter dialog.
  const channel: PromptChannel = remoteChannel ?? (entry?.running ? localChannel : { ...localChannel, blocked: "not running: Enter continues it in a new window" });
  const pending = session?.remote ? (remoteRead.pending[0] ?? session.remote.pending) : bridge ? (remoteRead.pending[0] ?? bridge.remote?.pending) : undefined;
  const canCompose = session !== undefined && (!channel.blocked || pending !== undefined);
  // The chat and the lists leave the prompt line its rows.
  const layout = session ? shorter(full, composerRows) : full;

  // What the chat reports (its filter, its attachments) and the Remote Control Viewer's own dialog keep the app's keys off.
  const [chatTyping, setChatTyping] = useState(false);
  const [chatModal, setChatModal] = useState(false);
  const [choice, setChoice] = useState<Choice>();
  useEffect(() => onTyping?.(chatTyping || typingInComposer), [chatTyping, typingInComposer]);
  useEffect(() => onModal?.(chatModal || choice !== undefined), [chatModal, choice]);
  useEffect(() => onClaimKeys?.(column === "chat" && canCompose), [column, canCompose]);
  const compose = () => {
    setColumn("chat");
    setComposing(true);
  };

  // Session viewers of the sessions listed, for the Enter dialog.
  const viewers = useSessionViewers(visible);
  const viewersFor = (s: SessionSummary) => viewersOf(viewers, s.remote ? { remoteId: s.id } : { ids: [s.id, ...(s.continues ?? [])], configDir: s.account ?? claudeDir() });
  const report = (done: string) => (p: Promise<void>) => p.then(() => notify(done), (err: Error) => notify(`not sent: ${err.message}`));
  /** The command that continues `e`'s session (a daemon's is attached to), or a remote one's address. */
  const commandOf = (e: RcViewerEntry) => {
    const s = e.session;
    if (s.remote) return remoteUrl(s.id);
    return e.running?.kind === "bg" && e.running.jobId ? `claude attach ${e.running.jobId}` : resumeCommand(s);
  };

  /** Enter on a session: what to do with it (`rcViewerOptions`), the usual choice for its state selected. */
  const start = (e: RcViewerEntry) => {
    const s = e.session;
    const dir = s.cwd ?? process.cwd();
    const { options, initial } = rcViewerOptions({
      state: e.state,
      remote: s.remote && { control: remoteControl, pending: s.remote.pending ?? (s.id === remoteId ? remoteRead.pending[0] : undefined) },
      running: e.running,
      bridge: e === entry && bridge ? { control: remoteControl, pending } : undefined,
      promptBlocked: s.remote ? undefined : channel.blocked,
      folderMissing: !s.remote && !existsSync(dir),
      terminal: detectTerminal() !== undefined,
      viewers: viewersFor(s).length,
      command: commandOf(e),
    });
    const lines = s.remote
      ? [truncate(sessionTitle(s), 56), "remote: it runs on another machine, read from claude.ai"]
      : sessionHead(s, { accounts: accountState, accountColor }, { dir, gone: !existsSync(dir), state: e.running ? "active" : "inactive" });
    setChoice({
      title: "What to do with this session?",
      lines,
      options,
      initial,
      onChoose: (id: string) => {
        setChoice(undefined);
        act(id as RcViewerAction, e);
      },
    });
  };

  const act = (id: RcViewerAction, e: RcViewerEntry) => {
    const s = e.session;
    switch (id) {
      case "switch":
        if (!e.running) return;
        notify("looking for its tab…");
        return void switchToSession(e.running, s.title ? [s.title] : []).then(notify);
      case "answer":
      case "prompt":
        return compose();
      case "interrupt":
        return void report("interrupt sent")(channel.interrupt());
      case "window":
        return notify(resumeInNewWindow(s.id, s.cwd ?? process.cwd(), truncate(sessionTitle(s), 30), "new", s.account));
      case "viewer": {
        const target: ViewerTarget = s.remote ? { remoteId: s.id } : { sessionId: s.id, cwd: s.cwd ?? process.cwd(), configDir: s.account };
        const opened = openSessionViewer(target, truncate(`${s.remote ? "◈ " : ""}${sessionTitle(s)}`, 30), viewerWindow());
        if (opened) return notify(opened);
        const command = viewerCommand(target);
        return void copy(command).then(() => notify(`no Windows Terminal or tmux: copied ${command}`), (err: Error) => notify(`copy failed: ${err.message}`));
      }
      case "viewer-front": {
        const last = viewersFor(s).filter((v) => v.window).at(-1);
        if (!last?.window) return notify("its viewers were not opened by cco: their window is unknown");
        return notify(focusSessionViewer(last.window) ? "its viewer is in front" : "no Windows Terminal or tmux");
      }
      case "copy": {
        const command = commandOf(e);
        return void copy(command).then(() => notify(`copied: ${command}`), (err: Error) => notify(`copy failed: ${err.message}`));
      }
    }
  };

  // The window's title counts the sessions waiting for the user.
  const waiting = entries.filter((e) => e.state === "waiting").length;
  const working = entries.filter((e) => e.state === "busy").length;
  useTerminalTitle(waiting > 0 ? `⚠${waiting} cco rc-viewer` : "cco rc-viewer", working > 0 ? "working" : "idle");

  // < > and | change the width of the list of the column that has the keys: the sessions', or the turns'.
  const folds = useRef<Record<"sessions" | "turns", FoldState>>({ sessions: UNFOLDED, turns: UNFOLDED });
  const before = useRef<Partial<Record<"sessions" | "turns", ColumnWidth>>>({});
  const widthKey = (c: RcViewerColumn) => (c === "sessions" ? "rcViewerSessionsWidth" : "rcViewerTurnsWidth");
  for (const c of ["sessions", "turns"] as const) {
    const width = readSettings()[widthKey(c)];
    if (!isListFold(width)) before.current[c] = width;
  }
  const changeWidth = (how: (width: ListWidth, state: FoldState) => { width: ListWidth; state: FoldState }) => {
    const which = column === "sessions" ? "sessions" : "turns";
    const key = widthKey(which);
    const width = readSettings()[key];
    const next = how(width, folds.current[which]);
    folds.current = { ...folds.current, [which]: next.state };
    if (next.width !== width) updateSettings({ [key]: next.width });
    notify(`${which} width: ${next.width}`);
  };

  // A click puts the keys in the column under it.
  // A click puts the keys in the column under it, or in the prompt line at the bottom.
  useMouse((e) => {
    if (e.kind !== "click" || e.y < 1) return;
    if (session && e.y >= full.rows - composerRows) {
      if (canCompose) compose();
      return;
    }
    setComposing(false);
    const sessionsEnd = aside;
    const turnsEnd = sessionsEnd + (aside > 0 ? 2 : 0) + (layout.fold === "hidden" ? 0 : layout.listWidth);
    setColumn(e.x < sessionsEnd ? "sessions" : e.x < turnsEnd ? "turns" : "chat");
  }, active && !choice);

  useInput(
    (input, key) => {
      // Space gives the prompt line the keys from every column; in the chat column Tab and i do too, as in a session viewer.
      if (input === " " && !key.ctrl && !key.meta) return void (canCompose && compose());
      if (column === "chat" && canCompose && (key.tab || input === "i")) return setComposing(true);
      // ← and → move between the columns; the sessions column folded away is skipped.
      if ((key.leftArrow || key.rightArrow) && !key.ctrl && !key.meta && !key.shift) {
        const shown = COLUMNS.filter((c) => (c !== "sessions" || aside > 0) && (c !== "turns" || layout.fold !== "hidden") && (c === "sessions" || aside < layout.columns));
        const at = Math.max(0, shown.indexOf(column));
        return setColumn(shown[Math.max(0, Math.min(shown.length - 1, at + (key.leftArrow ? -1 : 1)))]!);
      }
      if (input === "<" || input === ">") return changeWidth((w, s) => stepFold(w, s, input === "<" ? -1 : 1));
      if (input === "|") return changeWidth((w, s) => toggleFold(w, s, before.current[column === "sessions" ? "sessions" : "turns"]));
      // n: the next session that waits for the user, the one waiting longest first.
      if (input === "n") {
        const next = nextWaiting(entries, index, isFresh);
        if (next === undefined) return notify("no session waits for you");
        select(next);
        return setColumn("sessions");
      }
      if (column !== "sessions") return;
      if (key.upArrow) return select(index - 1);
      if (key.downArrow) return select(index + 1);
      if (key.home || input === "g") return select(0);
      if (key.end || input === "G") return select(entries.length - 1);
      if (key.pageUp) return select(index - (layout.bodyHeight - 2));
      if (key.pageDown) return select(index + (layout.bodyHeight - 2));
      if (key.return && entry) return start(entry);
    },
    { isActive: active && !typingInComposer && !choice },
  );

  const withAccounts = foreign.length > 0;
  const barOf = (s: SessionSummary) => {
    const account = s.account ? accountState.accounts.find((a) => a.dir === s.account) : accountState.accounts.find((a) => a.dir === claudeDir());
    return account ? barColorOfAccount(account, accountState, accountColor) : "gray";
  };
  const sessionsFocused = focused && column === "sessions";
  const list = (
    <FocusContext.Provider value={sessionsFocused}>
      <List
        items={entries}
        selected={index}
        height={layout.bodyHeight}
        empty="No session today"
        itemKey={(e) => e.key}
        group={(e) => RC_VIEWER_GROUPS[e.state]}
        onPick={(i) => {
          select(i);
          setColumn("sessions");
        }}
        lead={withAccounts ? (e) => <Text color={barOf(e.session)}>▌</Text> : undefined}
        render={(e, isSelected) => {
          const age = formatAge(now - e.since);
          const project = e.session.remote ? "claude.ai" : projectName(e.session);
          // ⇄: answered here, through claude.ai (a remote session, or one of this machine connected there); dim while steer remote is off.
          const steerable = e.state !== "ended" && (e.session.remote !== undefined || (!e.session.account && twins.has(e.session.id)));
          const width = Math.max(4, aside - (withAccounts ? 1 : 0) - 2 - (steerable ? 2 : 0) - stringWidth(age) - 1);
          return (
            <>
              <RcViewerMarker entry={e} fresh={isFresh(e)} />
              <Text> </Text>
              {steerable && (
                <Text color="cyan" dimColor={!remoteControl}>
                  {"⇄ "}
                </Text>
              )}
              <EntryText text={`${sessionTitle(e.session)} · ${project}`} width={width} selected={isSelected} active={sessionsFocused} />
              <Text dimColor={!isSelected}>{` ${age}`}</Text>
            </>
          );
        }}
      />
    </FocusContext.Provider>
  );
  const status = (
    <Text dimColor={!focused}>
      {waiting > 0 && <Text color="yellow">{`⚠ ${waiting} waiting · `}</Text>}
      {`${working} working · ${entries.length} today`}
      {remote.error && <Text color="red">{` · claude.ai: ${remote.error}`}</Text>}
      {" · "}
    </Text>
  );
  const columnItem: FooterItem = { text: `←→ ${column}`, on: true, priority: 4 };
  // n has somewhere to go: a session waits, or one just finished.
  const attention = waiting > 0 || entries.some((e) => e.state === "idle" && isFresh(e));
  const sessionsFooter: FooterItem[] = [
    columnItem,
    { text: "↑↓ session", priority: 4 },
    { text: "↵ act on it", priority: 3 },
    ...(attention ? [{ text: "n next", priority: 4 }] : []),
    { text: "< > | width", priority: 1 },
    { text: "1/2 view", priority: 1 },
  ];

  return (
    <ScreenAsideContext.Provider
      value={{ node: list, width: aside, status, focused, footer: column === "sessions" ? sessionsFooter : undefined, lead: [columnItem, ...(attention ? [{ text: "n next", priority: 4 }] : [])] }}
    >
      <Box flexDirection="column">
        <FocusContext.Provider value={focused && column !== "sessions" && !typingInComposer}>
          <ChatView
            cwd={session?.cwd ?? process.cwd()}
            path={path}
            transcript={transcript}
            layout={layout}
            active={active && column !== "sessions" && !choice}
            liveSession={live}
            onTyping={setChatTyping}
            onModal={setChatModal}
            previewKeys={column === "chat"}
            scrollOnly={typingInComposer}
            spaceMarks={false}
          />
        </FocusContext.Provider>
        {session && (
          <SessionComposer
            layout={full}
            channel={channel}
            title={`${session.remote ? "◈ " : ""}${sessionTitle(session)}`}
            working={entry?.state === "busy"}
            pending={pending}
            focused={typingInComposer && active}
            onFocus={setComposing}
            notify={notify}
            onHeight={setComposerRows}
            draftKey={entry?.key}
            hint={["Space", "or a click: write a prompt"]}
          />
        )}
      </Box>
      {choice && <ChoiceDialog key={choice.title} layout={full} choice={choice} onClose={() => setChoice(undefined)} />}
    </ScreenAsideContext.Provider>
  );
}
