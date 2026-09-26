import { basename } from "node:path";
import clipboard from "clipboardy";
import { Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { renderMarkdown } from "../render/markdown.js";
import { readFavorites, toggleFavorite } from "../favorites.js";
import { turnMarkdown } from "../transcript/parse.js";
import {
  dim,
  handleNavigation,
  List,
  previewHeader,
  rule,
  Screen,
  truncate,
  makeScroll,
  type Layout,
} from "./layout.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
import { useSetting } from "./useSetting.js";
import { useTranscript } from "./useTranscript.js";

interface Props {
  cwd: string;
  /** Transcript of the session to show (resolved by App). */
  path?: string;
  layout: Layout;
  active: boolean;
  /** Reports whether the full-prompt view is open, so Esc closes it instead of quitting. */
  onPromptOpen?: (open: boolean) => void;
}

const cyan = (s: string) => `\u001b[36m${s}\u001b[39m`;

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
export function promptHeader(prompt: string, width: number, height: number): string[] {
  const excerpt = prompt.length > PROMPT_PREVIEW_CHARS ? prompt.slice(0, PROMPT_PREVIEW_CHARS) + "…" : prompt;
  const full = previewHeader(excerpt, width, { marker: cyan("❯ "), style: dim });
  const fitted = fitHeader(full, height);
  const cut = excerpt !== prompt || fitted.length < full.length;
  return [...fitted.slice(0, -1), rule(width, cut ? "↵ full prompt" : undefined)];
}

/** The complete prompt, shown instead of the answer after Enter. */
function fullPrompt(prompt: string, width: number): { header: string[]; lines: string[] } {
  return {
    header: [cyan("❯ ") + "\u001b[1mPrompt\u001b[22m" + dim(" · ↵/esc back to answer"), rule(width)],
    lines: wrapAnsi(prompt, width, { hard: true, trim: false }).split("\n"),
  };
}

function time(ts?: string): string {
  if (!ts) return "     ";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ChatView({ cwd, path, layout, active, onPromptOpen }: Props) {
  const { turns, version } = useTranscript(path);
  const { listWidth, previewWidth, bodyHeight } = layout;

  const [selected, setSelected] = useState(0);
  const [follow, setFollow] = useState(true);
  const [showTools, setShowTools] = useSetting("showTools");
  const [showThinking, setShowThinking] = useSetting("showThinking");
  const [wrap, setWrap] = useSetting("chatWrap");
  const [hscroll, setHscroll] = useState(0);
  const [flash, setFlash] = useState<string>();
  const [promptOpen, setPromptOpen] = useState(false);
  const sessionId = path ? basename(path, ".jsonl") : undefined;
  // Marked (favourite) turns, kept across restarts.
  const [marks, setMarks] = useState<string[]>([]);

  useEffect(() => {
    setMarks(sessionId ? readFavorites(cwd, sessionId) : []);
  }, [cwd, sessionId]);

  const last = turns.length - 1;
  const current = turns[Math.min(selected, Math.max(0, last))];

  const answer = useMemo(() => {
    if (!current) return { header: [], lines: [] };
    const body = turnMarkdown(current, { tools: showTools, thinking: showThinking });
    return {
      header: promptHeader(current.prompt, previewWidth, bodyHeight),
      lines: body ? renderMarkdown(body, previewWidth, wrap) : [dim("(no text output yet)")],
    };
  }, [current, version, previewWidth, bodyHeight, showTools, showThinking, wrap]);
  const prompt = useMemo(
    () => (current && promptOpen ? fullPrompt(current.prompt, previewWidth) : undefined),
    [current, promptOpen, previewWidth],
  );
  const { header, lines } = prompt ?? answer;

  // Each turn remembers where its answer was scrolled to; unvisited turns start at the top.
  const positions = useRef(new Map<string, number>());
  const [pos, setPos] = useState(0);
  const [promptPos, setPromptPos] = useState(0);

  const live = follow && selected === last;
  const base = bodyHeightBelow(header, bodyHeight);
  // Not at the bottom of a longer answer: offer the way down, like Claude Code.
  // At the bottom means the last line is visible without the hint row (pos >= lines - base).
  const showJump = !promptOpen && !live && lines.length > base && pos < lines.length - base;
  const viewport = showJump ? base - 1 : base;
  const scroll = promptOpen
    ? makeScroll(promptPos, setPromptPos, lines.length, viewport)
    : makeScroll(pos, setPos, lines.length, viewport);

  // How far unwrapped answer lines can be shifted until the longest one ends at the right edge.
  // The full prompt is always wrapped.
  const maxHscroll = useMemo(
    () => (wrap || promptOpen ? 0 : Math.max(0, ...answer.lines.map((l) => stringWidth(l))) - previewWidth),
    [answer, wrap, promptOpen, previewWidth],
  );
  const shift = (delta: number) => setHscroll((h) => Math.max(0, Math.min(maxHscroll, h + delta)));

  const togglePrompt = (open: boolean) => {
    setPromptOpen(open);
    onPromptOpen?.(open);
    setPromptPos(0);
  };

  /** Switches to another turn, keeping the position of the one being left. */
  const showTurn = (index: number) => {
    if (current) positions.current.set(current.id, Math.min(pos, scroll.max));
    setSelected(index);
    setPos(positions.current.get(turns[index]?.id) ?? 0);
    setHscroll(0);
  };

  useEffect(() => {
    if (follow && last >= 0 && selected !== last) showTurn(last);
  }, [follow, last]);

  // Following: stick to the bottom of the latest answer while it grows.
  useEffect(() => {
    if (live && !promptOpen) setPos(scroll.max);
  }, [live, promptOpen, scroll.max]);

  /** Ctrl+End: the bottom of this answer; for the latest turn also resume following. */
  const jumpToBottom = () => {
    if (promptOpen) return scroll.set(scroll.max);
    if (selected === last) setFollow(true);
    else setPos(Math.max(0, lines.length - base));
  };

  // A new session starts with an empty transcript: reset the view.
  useEffect(() => {
    positions.current.clear();
    setSelected(0);
    setPos(0);
    setFollow(true);
  }, [path]);

  const select = (index: number) => {
    const next = Math.max(0, Math.min(last, index));
    if (next !== selected) showTurn(next);
    setFollow(next === last);
  };
  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(undefined), 2000);
  };
  const toggleMark = () => {
    if (current && sessionId) setMarks(toggleFavorite(cwd, sessionId, current.id));
  };
  /** Selects the next or previous marked turn. */
  const jumpMark = (dir: 1 | -1) => {
    const marked = turns.flatMap((t, i) => (marks.includes(t.id) ? [i] : []));
    const target = dir === 1 ? marked.find((i) => i > selected) : marked.reverse().find((i) => i < selected);
    if (target !== undefined) select(target);
  };

  useInput(
    (input, key) => {
      if (key.ctrl && key.end) return jumpToBottom();
      // Shift+←/→ scroll sideways; checked first because plain ←/→ switch turns.
      if (key.shift && (key.leftArrow || key.rightArrow)) return shift(key.leftArrow ? -HSCROLL_STEP : HSCROLL_STEP);
      if (input === "w") {
        setWrap((w) => !w);
        return setHscroll(0);
      }
      // Space marks the turn here instead of paging down.
      if (input === " ") return toggleMark();
      if (input === "]") return jumpMark(1);
      if (input === "[") return jumpMark(-1);
      const page = viewport - 2;
      if (!promptOpen && selected === last) {
        // Scrolling up leaves the live end; scrolling back to the bottom rejoins it.
        const up = key.upArrow || key.pageUp || input === "b" || key.home;
        const down = key.downArrow ? 1 : key.pageDown ? page : key.end ? scroll.max : 0;
        if (up && follow) setFollow(false);
        if (down && scroll.scroll + down >= scroll.max) setFollow(true);
      }
      const nav = {
        select: (delta: number) => select(selected + delta),
        first: () => select(0),
        last: () => select(last),
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
      if (input === "t") return setShowTools((v) => !v);
      if (input === "h") return setShowThinking((v) => !v);
      if (input === "c" && current) {
        const md = turnMarkdown(current, { tools: false, thinking: false });
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
        <>
          <Text dimColor>
            session {session} · {turns.length} turns · {scroll.position}
          </Text>
          {follow && <Text color="green"> · FOLLOW</Text>}
          {marks.length > 0 && <Text color="yellow"> · ★ {marks.length}</Text>}
          {showTools && <Text color="yellow"> · tools</Text>}
          {showThinking && <Text color="magenta"> · thinking</Text>}
          {!wrap && (
            <Text color="yellow"> · nowrap{hscroll > 0 ? ` +${Math.min(hscroll, maxHscroll)}` : ""}</Text>
          )}
        </>
      }
      list={
        <List
          items={turns}
          selected={selected}
          height={bodyHeight}
          empty="Waiting for prompts…"
          itemKey={(t, i) => t.id + i}
          render={(t, isSelected) => {
            const marked = marks.includes(t.id);
            return (
              <>
                <Text dimColor={!isSelected}>{time(t.timestamp)} </Text>
                {marked && <Text color="yellow">★ </Text>}
                {/* ↳ marks prompts sent while Claude was still working. */}
                {t.queued && <Text color="cyan">↳ </Text>}
                {truncate(t.prompt, Math.max(4, listWidth - 7 - (t.queued ? 2 : 0) - (marked ? 2 : 0)))}
              </>
            );
          }}
        />
      }
      preview={
        path ? (
          <Preview
            header={header}
            lines={lines}
            scroll={scroll.scroll}
            width={previewWidth}
            height={bodyHeight}
            hscroll={Math.min(hscroll, maxHscroll)}
            footer={showJump ? jumpHint(previewWidth) : undefined}
          />
        ) : (
          <Text dimColor>No Claude Code session found for {cwd}</Text>
        )
      }
      footer={
        flash ?? [
          { text: "←→ turn", priority: 4 },
          { text: "↑↓ scroll", priority: 1 },
          ...(wrap ? [] : [{ text: "⇧←→ side", priority: 4 }]),
          { text: "↵ prompt", on: promptOpen },
          { text: "f follow", on: follow },
          { text: "␣ mark", on: current !== undefined && marks.includes(current.id) },
          ...(marks.length > 0 ? [{ text: "[/] marked", priority: 2 }] : []),
          { text: "t tools", on: showTools, priority: 2 },
          { text: "h think", on: showThinking, priority: 2 },
          { text: "w wrap", on: wrap, priority: 2 },
          { text: "c copy", priority: 2 },
          { text: "1/2 view", priority: 1 },
        ]
      }
    />
  );
}
