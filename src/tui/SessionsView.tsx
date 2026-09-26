import clipboard from "clipboardy";
import { Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";
import { nextMarked } from "../favorites.js";
import { displayPath, formatDuration, insideProject, SessionIndex, type SessionSummary } from "../transcript/sessions.js";
import {
  deleteBlocker,
  emptyTrash,
  listTrash,
  purgeSession,
  restoreSession,
  runningSessionIds,
  trashSession,
  type TrashEntry,
} from "../transcript/trash.js";
import { resumeInNewTab } from "../open.js";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog.js";
import type { PlanStatus } from "../transcript/parse.js";
import { useFocused } from "./focus.js";
import {
  bold,
  dim,
  handleNavigation,
  List,
  markFooter,
  markKeys,
  previewHeader,
  Screen,
  Star,
  truncate,
  useScroll,
  wrapPath,
  type Layout,
} from "./layout.js";
import { planTitle } from "./PlanView.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
import { useFavorites } from "./useFavorites.js";

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
}

/** How often the sessions are re-read while the view is shown; only changed files are parsed again. */
const REFRESH_MS = 3000;

const STATUS_ICON: Record<PlanStatus, string> = {
  approved: "\u001b[32m✓\u001b[39m",
  rejected: "\u001b[31m✗\u001b[39m",
  pending: "\u001b[33m●\u001b[39m",
};
const green = (s: string) => `\u001b[32m${s}\u001b[39m`;
const red = (s: string) => `\u001b[31m${s}\u001b[39m`;
const heading = (s: string) => `\u001b[1;36m${s}\u001b[22;39m`;

const pad = (n: number) => String(n).padStart(2, "0");
function time(ts?: string): string {
  if (!ts) return "     ";
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** "09-26 22:48", short enough for the list. */
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

/** The name shown for a session: its /rename title, else its first prompt that is not a slash command. */
function sessionTitle(s: SessionSummary): string {
  return s.title ?? (s.prompts.find((p) => !p.text.startsWith("/")) ?? s.prompts[0])?.text ?? s.id;
}

/** Shell command that continues the session in Claude Code. */
export function resumeCommand(s: SessionSummary): string {
  return `claude --resume ${s.id}`;
}

/** Plans, changed files and prompts of a session, as lines of `width` columns. */
export function sessionLines(s: SessionSummary, cwd: string, width: number): string[] {
  const lines: string[] = [];
  const section = (title: string, count: number, body: string[]) => {
    if (lines.length) lines.push("");
    lines.push(heading(`${title} (${count})`));
    lines.push(...(count ? body : [dim("  none")]));
  };
  section(
    "Plans",
    s.plans.length,
    s.plans.map((p) => `  ${STATUS_ICON[p.status]} ${dim(time(p.timestamp))} ${truncate(planTitle(p.text), width - 10)}`),
  );
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
    s.prompts.map((p) => `  ${dim(time(p.timestamp))} ${truncate(p.text, width - 8)}`),
  );
  return lines;
}

type State = "active" | "running" | "trash" | undefined;

function sessionHeader(s: SessionSummary, state: State, width: number, deletedAt?: number): string[] {
  const when = [span(s.start, s.end), formatDuration(s.start, s.end), s.branch].filter(Boolean).join(" · ");
  const counts = [plural(s.prompts.length, "prompt"), plural(s.plans.length, "plan"), plural(s.files.length, "changed file")];
  const last =
    state === "trash"
      ? red(`in the trash since ${dateTime(new Date(deletedAt ?? 0).toISOString())} · u restores it`)
      : `${state === "active" ? "active · " : state === "running" ? "running elsewhere · " : ""}${resumeCommand(s)}`;
  return previewHeader(sessionTitle(s), width, {
    marker: state === "active" ? green("● ") : state === "running" ? green("▶ ") : "  ",
    style: bold,
    details: [when, counts.join(" · "), ...(s.cwd ? [`in ${tilde(s.cwd)}`] : []), last],
  });
}

/**
 * The project's sessions and which of them run in a Claude Code process, read
 * while `visible` and refreshed every few seconds. `refresh` rescans at once.
 */
function useSessions(cwd: string, visible: boolean) {
  const index = useRef<SessionIndex>(undefined);
  const scanRef = useRef<() => Promise<void>>(async () => {});
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [running, setRunning] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!visible) return;
    if (index.current?.cwd !== cwd) index.current = new SessionIndex(cwd);
    const current = index.current;
    let cancelled = false;
    let busy = false;
    const scan = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await current.scan();
        if (!cancelled) {
          setSessions(result);
          setRunning(runningSessionIds());
        }
      } finally {
        busy = false;
      }
    };
    scanRef.current = scan;
    void scan();
    const timer = setInterval(() => void scan(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cwd, visible]);

  return { sessions, running, refresh: () => void scanRef.current() };
}

export function SessionsView({ cwd, activePath, layout, visible, active, onTrashOpen, onModal }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const { sessions, running, refresh } = useSessions(cwd, visible);
  const activeId = activePath ? basename(activePath, ".jsonl") : undefined;
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  // The session moved to the trash last, for u (undo) in the list.
  const [lastTrashed, setLastTrashed] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  // Selected by id, so the selection stays when sessions are added; none yet means the newest.
  const [selectedId, setSelectedId] = useState<string>();
  const [trashSelectedId, setTrashSelectedId] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const favorites = useFavorites(cwd, "sessions");

  const list = trashOpen ? trash.map((e) => e.summary) : (sessions ?? []);
  const markedCount = (sessions ?? []).filter((s) => favorites.isMarked(s.id)).length;
  const currentId = trashOpen ? trashSelectedId : selectedId;
  const setCurrentId = trashOpen ? setTrashSelectedId : setSelectedId;

  const found = list.findIndex((s) => s.id === currentId);
  // The list starts at the newest session (last); the trash at the latest deletion (first).
  const index = found >= 0 ? found : trashOpen ? 0 : list.length - 1;
  const session = list[index];
  const entry = trashOpen ? trash[index] : undefined;
  const stateOf = (s: SessionSummary): State =>
    trashOpen ? "trash" : s.id === activeId ? "active" : running.has(s.id) ? "running" : undefined;

  const header = useMemo(() => {
    if (!session) return [];
    return fitHeader(sessionHeader(session, stateOf(session), previewWidth, entry?.deletedAt), bodyHeight);
  }, [session, activeId, running, trashOpen, entry, previewWidth, bodyHeight]);
  const lines = useMemo(
    () => (session ? sessionLines(session, cwd, previewWidth) : []),
    [session, cwd, previewWidth],
  );
  const viewport = bodyHeightBelow(header, bodyHeight);
  const scroll = useScroll(lines.length, viewport);

  useEffect(() => onModal?.(confirmation !== undefined), [confirmation]);
  useEffect(() => onTrashOpen?.(trashOpen), [trashOpen]);

  const select = (next: number) => {
    const target = list[Math.max(0, Math.min(list.length - 1, next))];
    if (!target || target.id === session?.id) return;
    setCurrentId(target.id);
    scroll.set(0);
  };
  /** After removing the selected entry: select its neighbour. */
  const selectNeighbour = () => setCurrentId((list[index + 1] ?? list[index - 1])?.id);

  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(undefined), 3000);
  };
  /** Runs a trash operation, reporting a failure instead of throwing. */
  const attempt = (action: () => void, done: string) => {
    try {
      action();
      notify(done);
    } catch (err) {
      notify(`failed: ${(err as Error).message}`);
    }
    setTrash(listTrash(cwd));
    refresh();
  };

  const toggleTrash = (open: boolean) => {
    if (open) setTrash(listTrash(cwd));
    setTrashOpen(open);
    scroll.set(0);
  };

  /** Enter: continues the session in a new terminal tab, unless it already runs somewhere. */
  const start = (s: SessionSummary) => {
    const state = stateOf(s);
    if (state === "active") return notify("this is the active session");
    if (runningSessionIds().has(s.id)) return notify("the session is already running in another Claude Code");
    const dir = s.cwd ?? cwd;
    if (!existsSync(dir)) return notify(`folder not found: ${tilde(dir)}`);
    notify(resumeInNewTab(s.id, dir, truncate(sessionTitle(s), 30)));
    // Show it as running as soon as Claude Code registers it.
    setTimeout(refresh, 3000);
  };

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
      action: "move to trash",
      onConfirm: () =>
        attempt(() => {
          trashSession(cwd, s, activeId);
          setLastTrashed(s.id);
          selectNeighbour();
        }, "moved to the trash · u undo · T trash"),
    });
  };
  const restore = (id: string, after?: () => void) =>
    attempt(() => {
      restoreSession(cwd, id);
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
      action: "delete for good",
      danger: true,
      onConfirm: () =>
        attempt(() => {
          purgeSession(cwd, s.id);
          selectNeighbour();
        }, "deleted for good"),
    });
  const askEmpty = () => {
    if (trash.length === 0) return;
    setConfirmation({
      title: "Empty the trash?",
      lines: [`${plural(trash.length, "session")} of this project will be deleted for good.`, "This can't be undone."],
      action: "empty trash",
      danger: true,
      onConfirm: () => attempt(() => void emptyTrash(cwd), "trash emptied"),
    });
  };

  useInput(
    (input, key) => {
      if (input === "T") return toggleTrash(!trashOpen);
      if (trashOpen) {
        if (key.escape) return toggleTrash(false);
        if (input === "u" && session) return restore(session.id, selectNeighbour);
        if (input === "x" && session) return askPurge(session);
        if (input === "X") return askEmpty();
      } else {
        // Checked first: Space marks instead of paging, Shift+←/→ jump between marked sessions.
        const mark = markKeys(input, key);
        if (mark === "toggle") return session && favorites.toggle(session.id);
        if (mark) {
          const target = nextMarked(
            list.map((s) => s.id),
            favorites.marks,
            index,
            mark,
          );
          return target !== undefined && select(target);
        }
        if ((input === "d" || key.delete) && session) return askDelete(session);
        if (input === "u") {
          if (!lastTrashed) return notify("nothing to undo");
          const id = lastTrashed;
          return restore(id, () => setSelectedId(id));
        }
        if (key.return && session) return start(session);
        if (input === "c" && session) {
          const command = resumeCommand(session);
          return void clipboard.write(command).then(
            () => notify(`copied: ${command}`),
            (err: Error) => notify(`copy failed: ${err.message}`),
          );
        }
      }
      handleNavigation(input, key, {
        select: (delta) => select(index + delta),
        first: () => select(0),
        last: () => select(list.length - 1),
        scroll,
        page: viewport - 2,
      });
    },
    { isActive: active && confirmation === undefined },
  );

  let preview;
  if (trashOpen && !session) preview = <Text dimColor>The trash is empty.</Text>;
  else if (!sessions) preview = <Text dimColor>Reading sessions…</Text>;
  else if (!session) preview = <Text dimColor>No Claude Code session found for {cwd}</Text>;
  else preview = <Preview header={header} lines={lines} scroll={scroll.scroll} width={previewWidth} height={bodyHeight} />;

  const footer = trashOpen
    ? [
        { text: "←→ session", priority: 4 },
        { text: "↑↓ scroll", priority: 1 },
        { text: "u restore", priority: 4 },
        { text: "x delete", priority: 3 },
        { text: "X empty", priority: 2 },
        { text: "T trash", on: true },
      ]
    : [
        { text: "←→ session", priority: 4 },
        { text: "↑↓ scroll", priority: 1 },
        ...markFooter(favorites.isMarked(session?.id), markedCount),
        { text: "↵ start", priority: 3 },
        { text: "c copy resume", priority: 2 },
        { text: "d delete", priority: 2 },
        ...(lastTrashed ? [{ text: "u undo", priority: 3 }] : []),
        { text: "T trash", priority: 2 },
        { text: "1-4 view", priority: 1 },
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
              plural(list.length, "session")
            ) : (
              "…"
            )}
            {session && ` · ${scroll.position}`}
            {!trashOpen && markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
          </Text>
        }
        list={
          <List
            items={list}
            selected={index}
            height={bodyHeight}
            empty={trashOpen ? "Trash is empty" : sessions ? "No sessions" : "…"}
            itemKey={(s) => s.id}
            render={(s, isSelected) => {
              const marked = favorites.isMarked(s.id);
              const state = stateOf(s);
              const badge = state === "active" ? "● " : state === "running" ? "▶ " : "";
              const deleted = trashOpen ? trash.find((e) => e.id === s.id)?.deletedAt : undefined;
              return (
                <>
                  {marked && <Star />}
                  <Text dimColor={!isSelected}>
                    {dateTime(deleted !== undefined ? new Date(deleted).toISOString() : s.start)}{" "}
                  </Text>
                  {badge && <Text color="green">{badge}</Text>}
                  {truncate(sessionTitle(s), Math.max(4, listWidth - 13 - (marked ? 2 : 0) - badge.length))}
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
    </>
  );
}
