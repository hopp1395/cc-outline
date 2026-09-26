import clipboard from "clipboardy";
import { Text, useInput } from "ink";
import { homedir } from "node:os";
import { basename } from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";
import { nextMarked } from "../favorites.js";
import { displayPath, formatDuration, insideProject, SessionIndex, type SessionSummary } from "../transcript/sessions.js";
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
}

/** How often the sessions are re-read while the view is shown; only changed files are parsed again. */
const REFRESH_MS = 3000;

const STATUS_ICON: Record<PlanStatus, string> = {
  approved: "\u001b[32m✓\u001b[39m",
  rejected: "\u001b[31m✗\u001b[39m",
  pending: "\u001b[33m●\u001b[39m",
};
const green = (s: string) => `\u001b[32m${s}\u001b[39m`;
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

function sessionHeader(s: SessionSummary, isActive: boolean, width: number): string[] {
  const when = [span(s.start, s.end), formatDuration(s.start, s.end), s.branch].filter(Boolean).join(" · ");
  const counts = [plural(s.prompts.length, "prompt"), plural(s.plans.length, "plan"), plural(s.files.length, "changed file")];
  return previewHeader(sessionTitle(s), width, {
    marker: isActive ? green("● ") : "  ",
    style: bold,
    details: [
      when,
      counts.join(" · "),
      ...(s.cwd ? [`in ${tilde(s.cwd)}`] : []),
      `${isActive ? "active · " : ""}${resumeCommand(s)}`,
    ],
  });
}

/** The project's sessions, read while `visible` and refreshed every few seconds. */
function useSessions(cwd: string, visible: boolean): SessionSummary[] | undefined {
  const index = useRef<SessionIndex>(undefined);
  const [sessions, setSessions] = useState<SessionSummary[]>();

  useEffect(() => {
    if (!visible) return;
    if (index.current?.cwd !== cwd) index.current = new SessionIndex(cwd);
    const current = index.current;
    let cancelled = false;
    let running = false;
    const scan = async () => {
      if (running) return;
      running = true;
      try {
        const result = await current.scan();
        if (!cancelled) setSessions(result);
      } finally {
        running = false;
      }
    };
    void scan();
    const timer = setInterval(() => void scan(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cwd, visible]);

  return sessions;
}

export function SessionsView({ cwd, activePath, layout, visible, active }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const sessions = useSessions(cwd, visible);
  const list = sessions ?? [];
  const activeId = activePath ? basename(activePath, ".jsonl") : undefined;
  // Selected by id, so the selection stays when sessions are added; none yet means the newest.
  const [selectedId, setSelectedId] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const favorites = useFavorites(cwd, "sessions");
  const markedCount = list.filter((s) => favorites.isMarked(s.id)).length;

  const found = list.findIndex((s) => s.id === selectedId);
  const index = found >= 0 ? found : list.length - 1;
  const session = list[index];

  const header = useMemo(() => {
    if (!session) return [];
    return fitHeader(sessionHeader(session, session.id === activeId, previewWidth), bodyHeight);
  }, [session, activeId, previewWidth, bodyHeight]);
  const lines = useMemo(
    () => (session ? sessionLines(session, cwd, previewWidth) : []),
    [session, cwd, previewWidth],
  );
  const viewport = bodyHeightBelow(header, bodyHeight);
  const scroll = useScroll(lines.length, viewport);

  const select = (next: number) => {
    const target = list[Math.max(0, Math.min(list.length - 1, next))];
    if (!target || target.id === session?.id) return;
    setSelectedId(target.id);
    scroll.set(0);
  };

  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(undefined), 2000);
  };

  useInput(
    (input, key) => {
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
      if (input === "c" && session) {
        const command = resumeCommand(session);
        return void clipboard.write(command).then(
          () => notify(`copied: ${command}`),
          (err: Error) => notify(`copy failed: ${err.message}`),
        );
      }
      handleNavigation(input, key, {
        select: (delta) => select(index + delta),
        first: () => select(0),
        last: () => select(list.length - 1),
        scroll,
        page: viewport - 2,
      });
    },
    { isActive: active },
  );

  let preview;
  if (!sessions) preview = <Text dimColor>Reading sessions…</Text>;
  else if (!session) preview = <Text dimColor>No Claude Code session found for {cwd}</Text>;
  else preview = <Preview header={header} lines={lines} scroll={scroll.scroll} width={previewWidth} height={bodyHeight} />;

  return (
    <Screen
      layout={layout}
      mode="sessions"
      status={
        <Text dimColor={!focused}>
          {sessions ? plural(list.length, "session") : "…"}
          {session && ` · ${scroll.position}`}
          {markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
        </Text>
      }
      list={
        <List
          items={list}
          selected={index}
          height={bodyHeight}
          empty={sessions ? "No sessions" : "…"}
          itemKey={(s) => s.id}
          render={(s, isSelected) => {
            const marked = favorites.isMarked(s.id);
            const isActive = s.id === activeId;
            return (
              <>
                {marked && <Star />}
                <Text dimColor={!isSelected}>{dateTime(s.start)} </Text>
                {isActive && <Text color="green">● </Text>}
                {truncate(sessionTitle(s), Math.max(4, listWidth - 13 - (marked ? 2 : 0) - (isActive ? 2 : 0)))}
              </>
            );
          }}
        />
      }
      preview={preview}
      footer={
        flash ?? [
          { text: "←→ session", priority: 4 },
          { text: "↑↓ scroll", priority: 1 },
          ...markFooter(favorites.isMarked(session?.id), markedCount),
          { text: "c copy resume", priority: 2 },
          { text: "1-4 view", priority: 1 },
        ]
      }
    />
  );
}
