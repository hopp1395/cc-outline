import { basename } from "node:path";
import clipboard from "clipboardy";
import { Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { renderMarkdown, stripBoxes } from "../render/markdown.js";
import { nextMarked } from "../favorites.js";
import { turnImageFiles } from "../images.js";
import { openInDefaultApp } from "../open.js";
import {
  AGENT_RUNNING_MARK,
  formatMs,
  formatTokens,
  agentStatusLine,
  agentTitle,
  turnMarkdown,
  type AgentRun,
  type Attachment,
  type Turn,
} from "../transcript/parse.js";
import { TOOL_LEVELS, type ToolLevel } from "../transcript/tools.js";
import { displayPath } from "../transcript/sessions.js";
import {
  bold,
  dim,
  handleNavigation,
  List,
  flipOrder,
  orderedDir,
  orderedNav,
  orderFooter,
  previewHeader,
  rule,
  Screen,
  markFooter,
  markKeys,
  EntryText,
  Spinner,
  Star,
  makeScroll,
  truncate,
  type Layout,
} from "./layout.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
import { useFocused } from "./focus.js";
import { useFavorites } from "./useFavorites.js";
import { usePositions } from "./usePositions.js";
import { useSetting } from "./useSetting.js";
import { useSubagent, type Subagent } from "./useSubagent.js";
import type { Transcript } from "./useTranscript.js";

interface Props {
  cwd: string;
  /** Transcript of the session to show (resolved by App). */
  path?: string;
  /** The parsed session (read by App, shared with the plan view). */
  transcript: Transcript;
  layout: Layout;
  active: boolean;
  /** Reports whether the full-prompt view is open, so Esc closes it instead of quitting. */
  onPromptOpen?: (open: boolean) => void;
  /** The viewer follows the running session, so its last unfinished turn is one Claude works on. */
  liveSession?: boolean;
}

/** t steps through the tool levels: off → compact → full → off. */
const nextToolLevel = (level: ToolLevel): ToolLevel => TOOL_LEVELS[(TOOL_LEVELS.indexOf(level) + 1) % TOOL_LEVELS.length];
const toolsFooter = (level: ToolLevel) => (level === "off" ? "t tools" : `t tools: ${level}`);

const red = (s: string) => `\u001b[31m${s}\u001b[39m`;

const magenta = (s: string) => `\u001b[35m${s}\u001b[39m`;
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** Where the running marks (⠿) of `lines` are, for the preview to spin them. */
export function spinnerMarks(lines: string[]): { line: number; col: number }[] {
  const marks: { line: number; col: number }[] = [];
  lines.forEach((line, i) => {
    const plain = stripAnsi(line);
    const at = plain.indexOf(AGENT_RUNNING_MARK);
    if (at >= 0) marks.push({ line: i, col: stringWidth(plain.slice(0, at)) });
  });
  return marks;
}

/** The subagents a turn started, or for a notification the one it reports on. */
export function turnAgents(turn: Turn | undefined, all: AgentRun[]): AgentRun[] {
  if (!turn) return [];
  if (turn.notification) return all.filter((a) => a.id === turn.notification!.toolUseId);
  return turn.blocks.flatMap((b) => (b.kind === "agent" ? [b.agent] : []));
}

/** What a subagent was asked and did, read from its own transcript (or, without one, its task and result). */
function agentView(
  agent: AgentRun,
  sub: Subagent,
  place: { index: number; count: number },
  width: number,
  opts: { tools: ToolLevel; thinking: boolean; wrap: boolean; live: boolean },
): { header: string[]; lines: string[] } {
  const where = place.count > 1 ? ` · ${place.index + 1} of ${place.count}` : "";
  const full = previewHeader(agentTitle(agent), width, {
    marker: magenta("◆ "),
    style: (t) => `\u001b[1m${t}\u001b[22m`,
    // The header does not spin; the body's "is working…" line does.
    details: [agentStatusLine(agent).replace(AGENT_RUNNING_MARK, "▶") + where],
  });
  const header = [...full.slice(0, -1), rule(width, place.count > 1 ? "←→ agent · a/esc back" : "a/esc back")];
  const quote = (text: string) => text.split("\n").map((l) => `> ${l}`).join("\n");
  const parts: string[] = [];
  if (sub.turns.length > 0) {
    sub.turns.forEach((t, i) => {
      parts.push(`**${i === 0 ? "Task" : "Message"}**`, quote(t.prompt));
      const body = turnMarkdown(t, { tools: opts.tools, thinking: opts.thinking, agents: true });
      if (body) parts.push(body);
    });
  } else {
    if (agent.prompt) parts.push("**Task**", quote(agent.prompt));
    if (agent.result) parts.push("**Result**", agent.result);
  }
  const lines = parts.length ? renderMarkdown(parts.join("\n\n"), width, opts.wrap) : [];
  if (agent.status === "running" && opts.live) lines.push("", dim(`${AGENT_RUNNING_MARK} ${agent.type ?? "Agent"} is working…`));
  else if (!sub.file && agent.status !== "running") lines.push("", dim("(the subagent's own transcript was not found)"));
  return { header, lines };
}

/** Colour of the ↩ of a notification by the task's status. */
const NOTIFICATION_COLOR: Record<string, string> = { completed: "green", failed: "red", killed: "red", stopped: "red" };

/** What ended a turn early, shown below its answer. */
function interruptLine(turn: Turn): string | undefined {
  if (turn.interrupted === "tool") return red("⊘ Interrupted by user during a tool call");
  if (turn.interrupted === "user") return red("⊘ Interrupted by user");
  return undefined;
}

const cyan = (s: string) => `\u001b[36m${s}\u001b[39m`;
const yellow = (s: string) => `\u001b[33m${s}\u001b[39m`;

/** A recap set apart from the answer: a heading and a bar down its left side. */
export function recapLines(text: string, width: number, wrap: boolean): string[] {
  const bar = yellow("▌ ");
  const body = renderMarkdown(text, Math.max(10, width - 2), wrap).map((l) => bar + `\u001b[3m${l}\u001b[23m`);
  return [bar + yellow(bold("※ Recap")), ...body];
}

/**
 * The rendered answer of a turn. Recaps interrupt the Markdown, which is
 * rendered in runs between them, so each shows where Claude Code wrote it.
 */
export function answerLines(turn: Turn, opts: { tools: ToolLevel; thinking: boolean; agents: boolean }, width: number, wrap: boolean): string[] {
  const lines: string[] = [];
  const add = (part: string[]) => {
    if (part.length === 0) return;
    if (lines.length > 0) lines.push("");
    lines.push(...part);
  };
  let run: Turn["blocks"] = [];
  const flush = () => {
    const md = run.length ? turnMarkdown({ ...turn, blocks: run }, opts) : "";
    if (md) add(renderMarkdown(md, width, wrap));
    run = [];
  };
  for (const b of turn.blocks) {
    if (b.kind !== "recap") {
      run.push(b);
      continue;
    }
    flush();
    add(recapLines(b.text, width, wrap));
  }
  flush();
  return lines;
}

/** Columns moved per Shift+←/→ when lines are not wrapped. */
const HSCROLL_STEP = 8;

const JUMP_LABEL =" ↓ Jump to bottom (ctrl+End) ";

/** The "jump to bottom" hint as a badge with a background, centred in `width`. */
export function jumpHint(width: number): string {
  const indent = Math.max(0, Math.floor((width - stringWidth(JUMP_LABEL)) / 2));
  return " ".repeat(indent) + "\u001b[48;2;38;79;120m\u001b[97m" + JUMP_LABEL + "\u001b[39m\u001b[49m";
}

/** Longest prompt excerpt shown above the answer; Enter opens the full prompt. */
export const PROMPT_PREVIEW_CHARS = 1000;

/**
 * Sticky prompt above the answer: at most PROMPT_PREVIEW_CHARS characters and
 * half the preview height. When cut, the rule points to the full prompt.
 */
export function promptHeader(prompt: string, width: number, height: number, attachments: Attachment[] = []): string[] {
  const excerpt = prompt.length > PROMPT_PREVIEW_CHARS ? prompt.slice(0, PROMPT_PREVIEW_CHARS) + "…" : prompt;
  const full = previewHeader(excerpt, width, { marker: cyan("❯ "), style: dim });
  // One row less for the prompt when the attachments line follows it.
  const summary = attachmentSummary(attachments);
  const fitted = fitHeader(full, summary ? height - 2 : height);
  const cut = excerpt !== prompt || fitted.length < full.length;
  return [
    ...fitted.slice(0, -1),
    ...(summary ? ["  " + dim(truncate(summary, width - 2))] : []),
    rule(width, cut || summary ? "↵ full prompt" : undefined),
  ];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `o` opens at most this many images of a turn at once. */
const MAX_OPENED_IMAGES = 10;

/** One line naming what came with the prompt: "📎 2 images · @src/Order.cs · 12 lines selected in Foo.cs". */
export function attachmentSummary(attachments: Attachment[]): string | undefined {
  if (attachments.length === 0) return undefined;
  const images = attachments.filter((a) => a.kind === "image").length;
  const parts = [
    ...(images > 0 ? [plural(images, "image")] : []),
    ...attachments.filter((a) => a.kind !== "image").map(attachmentName),
  ];
  return "📎 " + parts.join(" · ");
}

function attachmentName(a: Attachment): string {
  switch (a.kind) {
    case "image":
      return "image";
    case "file":
      return "@" + a.path.replace(/\\/g, "/");
    case "directory":
      return "@" + a.path.replace(/\\/g, "/").replace(/\/?$/, "/");
    case "selection": {
      const lines = a.lines !== undefined ? plural(a.lines, "line") : "lines";
      return `${lines} selected${a.file ? ` in ${a.file.replace(/\\/g, "/")}` : ""}`;
    }
  }
}

/** The attachments listed below the full prompt, images with where their file is. */
function attachmentLines(attachments: Attachment[], cwd: string): string[] {
  if (attachments.length === 0) return [];
  let image = 0;
  const lines = attachments.map((a) => {
    if (a.kind !== "image") return "  " + attachmentName(a);
    image++;
    return `  image ${image}  ${dim(a.path ? displayPath(a.path, cwd) : "(only in the transcript)")}`;
  });
  const hint = attachments.some((a) => a.kind === "image") ? [dim("  o opens the images")] : [];
  return ["", "\u001b[1m📎 Attachments\u001b[22m", ...lines, ...hint];
}

/** The complete prompt, shown instead of the answer after Enter. */
function fullPrompt(turn: Turn, width: number, cwd: string): { header: string[]; lines: string[] } {
  const n = turn.notification;
  // A notification's "prompt" is its summary; what the task returned comes below it.
  const usage = n
    ? [
        ...(n.durationMs !== undefined ? [formatMs(n.durationMs)] : []),
        ...(n.toolUses !== undefined ? [plural(n.toolUses, "tool use")] : []),
        ...(n.tokens !== undefined ? [formatTokens(n.tokens)] : []),
      ].join(" · ")
    : "";
  const result = n
    ? [
        "",
        dim(`${n.status}${usage ? ` · ${usage}` : ""}`),
        ...(n.result ? ["", ...renderMarkdown(n.result, width)] : []),
      ]
    : [];
  return {
    header: [cyan("❯ ") + `\u001b[1m${n ? "Task notification" : "Prompt"}\u001b[22m` + dim(" · ↵/esc back to answer"), rule(width)],
    lines: [
      ...wrapAnsi(turn.prompt, width, { hard: true, trim: false }).split("\n"),
      ...result,
      ...attachmentLines(turn.attachments ?? [], cwd).flatMap((l) => wrapAnsi(l, width, { hard: true, trim: false }).split("\n")),
    ],
  };
}

function time(ts?: string): string {
  if (!ts) return "     ";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ChatView({ cwd, path, transcript, layout, active, onPromptOpen, liveSession = false }: Props) {
  const { turns, version } = transcript;
  const { listWidth, previewWidth, bodyHeight } = layout;

  const [selected, setSelected] = useState(0);
  const [follow, setFollow] = useState(true);
  const [showTools, setShowTools] = useSetting("showTools");
  const [showThinking, setShowThinking] = useSetting("showThinking");
  const [wrap, setWrap] = useSetting("chatWrap");
  const [showAgents] = useSetting("showAgents");
  // Turns are kept oldest first; newest first only mirrors the list and its keys.
  const [order, setOrder] = useSetting("chatOrder");
  const reversed = order === "newest-first";
  // The subagent shown instead of the answer (a), by its place among the turn's agents.
  const [agentIndex, setAgentIndex] = useState<number>();
  const [agentPos, setAgentPos] = useState(0);
  const focused = useFocused();
  const [hscroll, setHscroll] = useState(0);
  const [flash, setFlash] = useState<string>();
  const [promptOpen, setPromptOpen] = useState(false);
  // Marked (favourite) turns of the project; they carry over into continued sessions.
  const favorites = useFavorites(cwd, "turns", path);
  const markedCount = turns.filter((t) => favorites.isMarked(t.id)).length;

  const last = turns.length - 1;
  const current = turns[Math.min(selected, Math.max(0, last))];
  // Claude works on the last turn until it is done or interrupted.
  const isRunning = (t: Turn | undefined) => liveSession && t !== undefined && t === turns[last] && !t.done && !t.interrupted;
  const agentsOf = (t: Turn | undefined) => turnAgents(t, transcript.agents);
  // Background agents keep running after their turn ended.
  const agentsRunning = (t: Turn) => liveSession && !t.notification && agentsOf(t).some((a) => a.status === "running");
  const currentAgents = agentsOf(current);
  const agent = agentIndex !== undefined ? currentAgents[agentIndex] : undefined;
  const subagent = useSubagent(agent?.transcript ?? path, agent);

  const answer = useMemo(() => {
    if (!current) return { header: [], lines: [] };
    const body = answerLines(current, { tools: showTools, thinking: showThinking, agents: showAgents }, previewWidth, wrap);
    const status = isRunning(current) ? dim("⠿ Claude is working…") : interruptLine(current);
    const lines = body.length ? body : status ? [] : [dim("(no text output yet)")];
    return {
      header: promptHeader(current.prompt, previewWidth, bodyHeight, current.attachments),
      lines: status ? [...lines, ...(lines.length ? [""] : []), status] : lines,
    };
  }, [current, version, previewWidth, bodyHeight, showTools, showThinking, showAgents, wrap, liveSession]);
  const prompt = useMemo(
    () => (current && promptOpen ? fullPrompt(current, previewWidth, cwd) : undefined),
    [current, version, promptOpen, previewWidth, cwd],
  );
  const agentPage = useMemo(
    () =>
      agent && agentIndex !== undefined
        ? agentView(agent, subagent, { index: agentIndex, count: currentAgents.length }, previewWidth, {
            tools: showTools,
            thinking: showThinking,
            wrap: true,
            live: liveSession,
          })
        : undefined,
    [agent, agentIndex, currentAgents.length, subagent.version, subagent.file, version, previewWidth, showTools, showThinking, liveSession],
  );
  const { header, lines } = agentPage ?? prompt ?? answer;
  const detailOpen = promptOpen || agentPage !== undefined;
  // Running agents spin in the answer (and in an agent's page), like "Claude is working…".
  const spinners = useMemo(() => (liveSession ? spinnerMarks(lines) : []), [lines, liveSession]);

  // Each turn remembers where its answer was scrolled to, also across restarts; unvisited turns start at the top.
  const remembered = usePositions(cwd, "chat");
  // The session whose remembered selection was restored (or found to be missing); nothing is stored before.
  const restoredFor = useRef<string | undefined>(undefined);
  const justRestored = useRef(false);
  // The selection stored for a turn this session does not have (see the restore below).
  const unrestored = useRef<string | undefined>(undefined);
  const [pos, setPos] = useState(0);
  const [promptPos, setPromptPos] = useState(0);

  const live = follow && selected === last;
  const base = bodyHeightBelow(header, bodyHeight);
  // Not at the bottom of a longer answer: offer the way down, like Claude Code.
  // At the bottom means the last line is visible without the hint row (pos >= lines - base).
  const showJump = !detailOpen && !live && lines.length > base && pos < lines.length - base;
  const viewport = showJump ? base - 1 : base;
  const scroll = agentPage
    ? makeScroll(agentPos, setAgentPos, lines.length, viewport)
    : promptOpen
    ? makeScroll(promptPos, setPromptPos, lines.length, viewport)
    : makeScroll(pos, setPos, lines.length, viewport);

  // How far unwrapped answer lines can be shifted until the longest one ends at the right edge.
  // The full prompt is always wrapped.
  const maxHscroll = useMemo(
    () => (wrap || detailOpen ? 0 : Math.max(0, ...answer.lines.map((l) => stringWidth(l))) - previewWidth),
    [answer, wrap, detailOpen, previewWidth],
  );
  const shift = (delta: number) => setHscroll((h) => Math.max(0, Math.min(maxHscroll, h + delta)));

  const togglePrompt = (open: boolean) => {
    setPromptOpen(open);
    setAgentIndex(undefined);
    onPromptOpen?.(open);
    setPromptPos(0);
  };
  /** Shows the turn's subagent at `index` instead of the answer; undefined goes back. */
  const showAgent = (index: number | undefined) => {
    setAgentIndex(index);
    setAgentPos(0);
    setPromptOpen(false);
    onPromptOpen?.(index !== undefined);
    // Stay on this turn while reading about its agents.
    if (index !== undefined) setFollow(false);
  };

  /** Switches to another turn, keeping the position of the one being left. */
  const showTurn = (index: number) => {
    // Before the session's turns were restored, `current` is just the initial first turn, not a place the user left.
    if (current && restoredFor.current === path) remembered.set(current.id, detailOpen ? pos : Math.min(pos, scroll.max));
    if (agentIndex !== undefined) {
      setAgentIndex(undefined);
      onPromptOpen?.(promptOpen);
    }
    setSelected(index);
    setPos(remembered.get(turns[index]?.id));
    setHscroll(0);
  };

  // A new session: reset the view. Its turns can come in the same render (a session continued from
  // other transcripts is read at once), so the effects below run after this one and settle the selection.
  useEffect(() => {
    setSelected(0);
    setPos(0);
    setFollow(true);
  }, [path]);

  // Following: select the newest turn, also of a session just switched to (then `selected` is the old session's).
  useEffect(() => {
    if (follow && last >= 0) showTurn(last);
  }, [follow, last, path]);

  // Following: stick to the bottom of the latest answer while it grows.
  useEffect(() => {
    if (live && !detailOpen) setPos(scroll.max);
  }, [live, detailOpen, scroll.max]);

  /** Ctrl+End: the bottom of this answer; for the latest turn also resume following. */
  const jumpToBottom = () => {
    if (detailOpen) return scroll.set(scroll.max);
    if (selected === last) setFollow(true);
    else setPos(Math.max(0, lines.length - base));
  };

  // Once the turns of a session are there: back to the turn selected last time, unless the newest was followed.
  useEffect(() => {
    if (!path || restoredFor.current === path || turns.length === 0) return;
    restoredFor.current = path;
    const at = remembered.follow === false ? turns.findIndex((t) => t.id === remembered.selected) : -1;
    // A turn of another session, e.g. the one /resume brings back: kept while this one is only followed.
    unrestored.current = at < 0 && remembered.follow === false ? remembered.selected : undefined;
    if (at < 0) return;
    justRestored.current = true;
    setFollow(false);
    setSelected(at);
    setPos(remembered.get(turns[at].id));
  }, [path, turns.length]);

  // Keep the selection and this turn's position (the full prompt has its own, not kept).
  useEffect(() => {
    if (restoredFor.current !== path || justRestored.current) {
      justRestored.current = false;
      return;
    }
    if (!current) return;
    if (live && unrestored.current) return;
    unrestored.current = undefined;
    remembered.select(current.id, live);
    if (!detailOpen) remembered.set(current.id, pos);
  }, [current?.id, live, pos, detailOpen]);

  const select = (index: number) => {
    // The user chose: from now on their selection is the one kept.
    unrestored.current = undefined;
    const next = Math.max(0, Math.min(last, index));
    if (next !== selected) showTurn(next);
    setFollow(next === last);
  };
  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(undefined), 2000);
  };
  const imageCount = (current?.attachments ?? []).filter((a) => a.kind === "image").length;
  /** Opens the images pasted into `turn`'s prompt in the system's image viewer. */
  const openImages = (turn: Turn) => {
    if (imageCount === 0) return;
    let files: string[];
    try {
      files = turnImageFiles(turn.transcript ?? path, turn).slice(0, MAX_OPENED_IMAGES);
    } catch (err) {
      return notify(`could not read the images: ${(err as Error).message}`);
    }
    if (files.length === 0) return notify("the images are no longer available");
    for (const file of files) openInDefaultApp(file);
    notify(`opened ${plural(files.length, "image")}`);
  };
  /** Mouse wheel over the answer: like ↑/↓, scrolling up leaves the live end and scrolling back down rejoins it. */
  const wheel = (delta: number) => {
    if (!detailOpen && selected === last) {
      if (delta < 0 && follow) setFollow(false);
      if (delta > 0 && scroll.scroll + delta >= scroll.max) setFollow(true);
    }
    scroll.by(delta);
  };
  /** Selects the next or previous marked turn. */
  const jumpMark = (dir: 1 | -1) => {
    const target = nextMarked(
      turns.map((t) => t.id),
      favorites.marks,
      selected,
      orderedDir(reversed, dir),
    );
    if (target !== undefined) select(target);
  };

  useInput(
    (input, key) => {
      // A subagent's page takes ←→ for its siblings; a or Esc goes back to the answer.
      if (agentPage) {
        if (input === "a" || key.escape) return showAgent(undefined);
        if (key.ctrl && key.end) return scroll.set(scroll.max);
        if (input === "t") return setShowTools(nextToolLevel);
        if (input === "h") return setShowThinking((v) => !v);
        const pick = (i: number) => showAgent(Math.max(0, Math.min(currentAgents.length - 1, i)));
        handleNavigation(input, key, {
          select: (delta) => pick((agentIndex ?? 0) + delta),
          first: () => pick(0),
          last: () => pick(currentAgents.length - 1),
          scroll,
          page: viewport - 2,
        });
        return;
      }
      if (input === "a") return currentAgents.length > 0 ? showAgent(0) : notify("no subagents in this turn");
      if (key.ctrl && key.end) return jumpToBottom();
      // Checked first because plain ←/→ switch turns.
      const mark = markKeys(input, key);
      if (mark === "toggle") return current && favorites.toggle(current.id);
      if (mark) return jumpMark(mark);
      if (key.ctrl && (key.leftArrow || key.rightArrow)) return shift(key.leftArrow ? -HSCROLL_STEP : HSCROLL_STEP);
      if (input === "w") {
        setWrap((w) => !w);
        return setHscroll(0);
      }
      const page = viewport - 2;
      if (!detailOpen && selected === last) {
        // Scrolling up leaves the live end; scrolling back to the bottom rejoins it.
        const up = key.upArrow || key.pageUp || input === "b" || (key.ctrl && key.home);
        const down = key.downArrow ? 1 : key.pageDown ? page : 0;
        if (up && follow) setFollow(false);
        if (down && scroll.scroll + down >= scroll.max) setFollow(true);
      }
      const nav = {
        ...orderedNav(reversed, {
          select: (delta: number) => select(selected + delta),
          first: () => select(0),
          last: () => select(last),
        }),
        scroll,
        page,
      };
      if (handleNavigation(input, key, nav)) return;
      if (key.return && current) return togglePrompt(!promptOpen);
      if (key.escape && promptOpen) return togglePrompt(false);
      if (input === "f") {
        if (follow) setFollow(false);
        else select(last);
        return notify(follow ? "follow off" : "follow on");
      }
      if (input === "s") return setOrder(flipOrder);
      if (input === "o" && current) return openImages(current);
      if (input === "t") return setShowTools(nextToolLevel);
      if (input === "h") return setShowThinking((v) => !v);
      if (input === "c" && current) {
        const md = stripBoxes(turnMarkdown(current, { tools: "off", thinking: false }));
        clipboard.write(md).then(
          () => notify("copied Markdown to clipboard"),
          (err: Error) => notify(`copy failed: ${err.message}`),
        );
      }
    },
    { isActive: active },
  );

  const session = path ? basename(path, ".jsonl").slice(0, 8) : "none";

  return (
    <Screen
      layout={layout}
      mode="chat"
      status={
        // Full brightness on the focused (blue) bar, dimmed otherwise.
        <Text dimColor={!focused}>
          session {session} · {turns.length} turns · {scroll.position}
          {markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
          {/* Options (follow, tools, thinking, wrap) show as highlighted keys in the help line, not here. */}
          {!wrap && hscroll > 0 && ` · → ${Math.min(hscroll, maxHscroll)} cols`}
        </Text>
      }
      list={
        <List
            reversed={reversed}
            onPick={select}
          items={turns}
          selected={selected}
          height={bodyHeight}
          empty="Waiting for prompts…"
          itemKey={(t, i) => t.id + i}
          render={(t, isSelected) => {
            const marked = favorites.isMarked(t.id);
            // Claude works on it, or subagents it started still run.
            const running = isRunning(t) || agentsRunning(t);
            const agentCount = t.notification ? 0 : agentsOf(t).length;
            const badge = agentCount > 0 ? `◆${agentCount} ` : "";
            return (
              <>
                {marked && <Star />}
                {/* The turn Claude works on spins; one the user stopped shows ⊘. */}
                {running && (
                  <>
                    <Spinner active={active} />{" "}
                  </>
                )}
                {t.interrupted && <Text color="red">⊘ </Text>}
                <Text dimColor={!isSelected}>{time(t.timestamp)} </Text>
                {/* ↳ marks prompts sent while Claude was still working, ↩ a background task reporting back. */}
                {t.queued && <Text color="cyan">↳ </Text>}
                {t.notification && <Text color={NOTIFICATION_COLOR[t.notification.status] ?? "yellow"}>↩ </Text>}
                {badge && <Text color="magenta">{badge}</Text>}
                <EntryText
                  text={t.prompt}
                  width={Math.max(
                    4,
                    listWidth -
                      7 -
                      (t.queued || t.notification ? 2 : 0) -
                      (marked ? 2 : 0) -
                      (running || t.interrupted ? 2 : 0) -
                      badge.length,
                  )}
                  selected={isSelected}
                  active={active}
                />
              </>
            );
          }}
        />
      }
      preview={
        path ? (
          <Preview
            onWheel={wheel}
            onLink={(url) => notify(`opened ${url}`)}
            header={header}
            lines={lines}
            scroll={scroll.scroll}
            width={previewWidth}
            height={bodyHeight}
            hscroll={Math.min(hscroll, maxHscroll)}
            footer={showJump ? jumpHint(previewWidth) : undefined}
            // The "Claude is working…" line ends the answer of the running turn.
            spinner={spinners.length ? { at: spinners, active } : undefined}
          />
        ) : (
          <Text dimColor>No Claude Code session found for {cwd}</Text>
        )
      }
      footer={
        flash ??
        (agentPage ? [
          ...(currentAgents.length > 1 ? [{ text: "←→ agent", priority: 4 }] : []),
          { text: "↑↓ scroll", priority: 1 },
          { text: "a agent", on: true },
          { text: toolsFooter(showTools), on: showTools !== "off", priority: 2 },
          { text: "h think", on: showThinking, priority: 2 },
        ] : [
          { text: "←→ turn", priority: 4 },
          { text: "↑↓ scroll", priority: 1 },
          ...(wrap ? [] : [{ text: "^←→ side", priority: 4 }]),
          { text: "↵ prompt", on: promptOpen },
          { text: "f follow", on: follow },
          orderFooter(order, "oldest-first"),
          ...markFooter(favorites.isMarked(current?.id), markedCount),
          { text: toolsFooter(showTools), on: showTools !== "off", priority: 2 },
          { text: "h think", on: showThinking, priority: 2 },
          { text: "w wrap", on: wrap, priority: 2 },
          { text: "c copy", priority: 2 },
          ...(imageCount > 0 ? [{ text: `o ${plural(imageCount, "image")}`, priority: 3 }] : []),
          ...(currentAgents.length > 0 ? [{ text: `a ${plural(currentAgents.length, "agent")}`, priority: 3 }] : []),
          { text: "1-6/tab view", priority: 1 },
        ])
      }
    />
  );
}
