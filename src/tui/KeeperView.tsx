import { Text, useInput } from "ink";
import { join, resolve } from "node:path";
import type { KeeperSelect } from "../keeper/registry.js";
import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { barColorOfAccount, type Account } from "../account.js";
import { otherAccounts } from "../accountContinue.js";
import { formatAge, KEEPER_GROUPS, keeperEntries, nextWaiting, runningStandIn, type KeeperEntry, type SeenStates } from "../keeper/state.js";
import { remotePath } from "../remote/index.js";
import { rangeStart, readSettings, updateSettings, type ColumnWidth, type ListWidth } from "../settings.js";
import { TIMING } from "../timing.js";
import { claudeDir, inClaudeDir, projectDir } from "../transcript/locate.js";
import type { SessionSummary } from "../transcript/sessions.js";
import { isListFold } from "../settings.js";
import { ChatView } from "./ChatView.js";
import { dayOf } from "./days.js";
import { FocusContext, useFocused } from "./focus.js";
import { EntryText, List, ScreenAsideContext, type FooterItem, type Layout } from "./layout.js";
import { stepFold, toggleFold, UNFOLDED, type FoldState } from "./listFold.js";
import { useMouse } from "./mouse.js";
import { projectName, SessionMarker } from "./SessionsView.js";
import { sessionTitle } from "./sessionHead.js";
import { useTerminalTitle } from "./title.js";
import { useAccountState } from "./useAccount.js";
import { useRemoteTranscript } from "./useRemoteTranscript.js";
import { mergeRemote, sessionKey, useRemoteSessions, useRunning, useSessions } from "./useSessionData.js";
import { useSetting } from "./useSetting.js";
import { useTranscript } from "./useTranscript.js";

/** The keeper's columns, left to right: `←` and `→` move the keys between them. */
export type KeeperColumn = "sessions" | "turns" | "chat";
const COLUMNS: KeeperColumn[] = ["sessions", "turns", "chat"];

interface Props {
  /** The layout of the turns and the chat, beside the sessions column (`keeperLayout`). */
  layout: Layout;
  /** The sessions column's width (`keeperLayout`'s `aside`). */
  aside: number;
  /** The keeper is shown (its data is read only then). */
  visible: boolean;
  /** The view takes keys. */
  active: boolean;
  onTyping?: (typing: boolean) => void;
  onModal?: (open: boolean) => void;
  /** A short message in the bottom row (the width after `<` or `>`). */
  notify: (text: string) => void;
  /** A session to select, once per `at`: as soon as the list has it. */
  request?: KeeperSelect & { at: number };
}

/** The sessions of the accounts other than this one, among those found. */
const foreignDirs = (accounts: Account[]) => otherAccounts(accounts).map((a) => a.dir);

/** The id in a `sessionKey` (another account's carries its folder before a `|`). */
const idOfKey = (key: string) => key.slice(key.lastIndexOf("|") + 1);
const accountOfKey = (key: string) => (key.includes("|") ? key.slice(0, key.lastIndexOf("|")) : undefined);

const samePath = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** Whether `s` is the session `request` asks for: a remote one by its id, one of this machine by an id of its chain in its config folder. */
export function matchesRequest(s: SessionSummary, request: KeeperSelect): boolean {
  if (request.remote || s.remote) return Boolean(request.remote && s.remote && s.id === request.id);
  if (s.id !== request.id && !(s.continues ?? []).includes(request.id)) return false;
  return !request.configDir || samePath(s.account ?? claudeDir(), request.configDir);
}

/** The marker of a session in the keeper's list: ⚠ waits, ● works (blinking) or is idle, ∅ ended; ◈ for a remote one. */
function KeeperMarker({ entry }: { entry: KeeperEntry }) {
  const { state, session } = entry;
  if (state === "waiting") return <Text color="yellow">⚠</Text>;
  if (state === "ended") return <Text dimColor>∅</Text>;
  const symbol = session.remote ? "◈" : "●";
  return <SessionMarker symbol={symbol} activity={state === "busy" ? "busy" : "idle"} color={session.remote ? "cyan" : "green"} />;
}

/**
 * The keeper (`cco keeper`): the sessions that run or ran today, of every project and account and claude.ai
 * (setting remote API), grouped by what they need (waiting, working, idle, ended); beside them the selected session's
 * turns and the chat of the selected turn, live. `←` and `→` move the keys between the three columns.
 */
export function KeeperView({ layout, aside, visible, active, onTyping, onModal, notify, request }: Props) {
  const focused = useFocused();
  const [column, setColumn] = useState<KeeperColumn>("sessions");
  const accountState = useAccountState();
  const [accountColor] = useSetting("accountColor");
  const [remoteApi] = useSetting("remoteApi");
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
  const entries = useMemo(() => {
    const { merged } = mergeRemote(read ?? [], remote.sessions);
    const known = new Set(merged.map(sessionKey));
    const standIns: SessionSummary[] = [];
    for (const [key, run] of running) {
      if (known.has(key) || !run.cwd) continue;
      const account = accountOfKey(key);
      const id = idOfKey(key);
      const dir = account ? inClaudeDir(account, () => projectDir(run.cwd!)) : projectDir(run.cwd);
      standIns.push(runningStandIn(id, run, join(dir, `${id}.jsonl`), account));
    }
    return keeperEntries([...merged, ...standIns], running, sessionKey, seen.current, now, dayStart);
  }, [read, remote.sessions, running, now, dayStart]);

  // Kept by key: the entries move between the groups as their sessions change.
  const [selectedKey, setSelectedKey] = useState<string>();
  const lastIndex = useRef(0);
  const found = selectedKey === undefined ? -1 : entries.findIndex((e) => e.key === selectedKey);
  const index = found >= 0 ? found : Math.min(lastIndex.current, Math.max(0, entries.length - 1));
  lastIndex.current = index;
  const entry = entries[index];
  // A session asked for (Sessions, /cco:keeper) is selected once the list has it, the keys in the sessions column.
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

  // The selected session's turns: a local one from its transcript, a remote one from claude.ai.
  const session = entry?.session;
  const local = useTranscript(session && !session.remote ? session.path : undefined);
  const remoteRead = useRemoteTranscript(session?.remote ? session.id : undefined);
  const transcript = session?.remote ? remoteRead : local;
  const path = !session ? undefined : session.remote ? remotePath(session.id) : (local.file ?? session.path);
  const live = entry !== undefined && (entry.state === "busy" || entry.state === "waiting");

  // The window's title counts the sessions waiting for the user.
  const waiting = entries.filter((e) => e.state === "waiting").length;
  const working = entries.filter((e) => e.state === "busy").length;
  useTerminalTitle(waiting > 0 ? `⚠${waiting} cco keeper` : "cco keeper", working > 0 ? "working" : "idle");

  // < > and | change the width of the list of the column that has the keys: the sessions', or the turns'.
  const folds = useRef<Record<"sessions" | "turns", FoldState>>({ sessions: UNFOLDED, turns: UNFOLDED });
  const before = useRef<Partial<Record<"sessions" | "turns", ColumnWidth>>>({});
  const widthKey = (c: KeeperColumn) => (c === "sessions" ? "keeperSessionsWidth" : "keeperTurnsWidth");
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
  useMouse((e) => {
    if (e.kind !== "click" || e.y < 1) return;
    const sessionsEnd = aside;
    const turnsEnd = sessionsEnd + (aside > 0 ? 2 : 0) + (layout.fold === "hidden" ? 0 : layout.listWidth);
    setColumn(e.x < sessionsEnd ? "sessions" : e.x < turnsEnd ? "turns" : "chat");
  }, active);

  useInput(
    (input, key) => {
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
        const next = nextWaiting(entries, index);
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
      if (key.return && entry) return setColumn("turns");
    },
    { isActive: active },
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
        group={(e) => KEEPER_GROUPS[e.state]}
        onPick={(i) => {
          select(i);
          setColumn("sessions");
        }}
        lead={withAccounts ? (e) => <Text color={barOf(e.session)}>▌</Text> : undefined}
        render={(e, isSelected) => {
          const age = formatAge(now - e.since);
          const project = e.session.remote ? "claude.ai" : projectName(e.session);
          const width = Math.max(4, aside - (withAccounts ? 1 : 0) - 2 - stringWidth(age) - 1);
          return (
            <>
              <KeeperMarker entry={e} />
              <Text> </Text>
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
  const sessionsFooter: FooterItem[] = [
    columnItem,
    { text: "↑↓ session", priority: 4 },
    { text: "↵ turns", priority: 3 },
    ...(waiting > 0 ? [{ text: "n next waiting", priority: 4 }] : []),
    { text: "< > | width", priority: 1 },
    { text: "1/2 view", priority: 1 },
  ];

  return (
    <ScreenAsideContext.Provider
      value={{ node: list, width: aside, status, focused, footer: column === "sessions" ? sessionsFooter : undefined, lead: [columnItem, ...(waiting > 0 ? [{ text: "n next waiting", priority: 4 }] : [])] }}
    >
      <FocusContext.Provider value={focused && column !== "sessions"}>
        <ChatView
          cwd={session?.cwd ?? process.cwd()}
          path={path}
          transcript={transcript}
          layout={layout}
          active={active && column !== "sessions"}
          liveSession={live}
          onTyping={onTyping}
          onModal={onModal}
          previewKeys={column === "chat"}
        />
      </FocusContext.Provider>
    </ScreenAsideContext.Provider>
  );
}
