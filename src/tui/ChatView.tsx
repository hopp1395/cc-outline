import { basename } from "node:path";
import clipboard from "clipboardy";
import { Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { renderMarkdown } from "../render/markdown.js";
import { nextMarked } from "../favorites.js";
import { turnImageFiles } from "../images.js";
import { openInDefaultApp } from "../open.js";
import { turnMarkdown, type Attachment, type Turn } from "../transcript/parse.js";
import { displayPath } from "../transcript/sessions.js";
import {
  dim,
  handleNavigation,
  List,
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

const red = (s: string) => `\u001b[31m${s}\u001b[39m`;

/** What ended a turn early, shown below its answer. */
function interruptLine(turn: Turn): string | undefined {
  if (turn.interrupted === "tool") return red("⊘ Interrupted by user during a tool call");
  if (turn.interrupted === "user") return red("⊘ Interrupted by user");
  return undefined;
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
  return {
    header: [cyan("❯ ") + "\u001b[1mPrompt\u001b[22m" + dim(" · ↵/esc back to answer"), rule(width)],
    lines: [
      ...wrapAnsi(turn.prompt, width, { hard: true, trim: false }).split("\n"),
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

  const answer = useMemo(() => {
    if (!current) return { header: [], lines: [] };
    const body = turnMarkdown(current, { tools: showTools, thinking: showThinking });
    const status = isRunning(current) ? dim("⠿ Claude is working…") : interruptLine(current);
    const lines = body ? renderMarkdown(body, previewWidth, wrap) : status ? [] : [dim("(no text output yet)")];
    return {
      header: promptHeader(current.prompt, previewWidth, bodyHeight, current.attachments),
      lines: status ? [...lines, ...(lines.length ? [""] : []), status] : lines,
    };
  }, [current, version, previewWidth, bodyHeight, showTools, showThinking, wrap, liveSession]);
  const prompt = useMemo(
    () => (current && promptOpen ? fullPrompt(current, previewWidth, cwd) : undefined),
    [current, version, promptOpen, previewWidth, cwd],
  );
  const { header, lines } = prompt ?? answer;

  // Each turn remembers where its answer was scrolled to, also across restarts; unvisited turns start at the top.
  const remembered = usePositions(cwd, "chat");
  // The session whose remembered selection was restored (or found to be missing); nothing is stored before.
  const restoredFor = useRef<string | undefined>(undefined);
  const justRestored = useRef(false);
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
    // Before the session's turns were restored, `current` is just the initial first turn, not a place the user left.
    if (current && restoredFor.current === path) remembered.set(current.id, Math.min(pos, scroll.max));
    setSelected(index);
    setPos(remembered.get(turns[index]?.id));
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
    setSelected(0);
    setPos(0);
    setFollow(true);
  }, [path]);

  // Once the turns of a session are there: back to the turn selected last time, unless the newest was followed.
  useEffect(() => {
    if (!path || restoredFor.current === path || turns.length === 0) return;
    restoredFor.current = path;
    const at = remembered.follow === false ? turns.findIndex((t) => t.id === remembered.selected) : -1;
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
    remembered.select(current.id, live);
    if (!promptOpen) remembered.set(current.id, pos);
  }, [current?.id, live, pos, promptOpen]);

  const select = (index: number) => {
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
      files = turnImageFiles(path, turn).slice(0, MAX_OPENED_IMAGES);
    } catch (err) {
      return notify(`could not read the images: ${(err as Error).message}`);
    }
    if (files.length === 0) return notify("the images are no longer available");
    for (const file of files) openInDefaultApp(file);
    notify(`opened ${plural(files.length, "image")}`);
  };
  /** Selects the next or previous marked turn. */
  const jumpMark = (dir: 1 | -1) => {
    const target = nextMarked(
      turns.map((t) => t.id),
      favorites.marks,
      selected,
      dir,
    );
    if (target !== undefined) select(target);
  };

  useInput(
    (input, key) => {
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
      if (!promptOpen && selected === last) {
        // Scrolling up leaves the live end; scrolling back to the bottom rejoins it.
        const up = key.upArrow || key.pageUp || input === "b" || (key.ctrl && key.home);
        const down = key.downArrow ? 1 : key.pageDown ? page : 0;
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
      if (input === "o" && current) return openImages(current);
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
          items={turns}
          selected={selected}
          height={bodyHeight}
          empty="Waiting for prompts…"
          itemKey={(t, i) => t.id + i}
          render={(t, isSelected) => {
            const marked = favorites.isMarked(t.id);
            const running = isRunning(t);
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
                {/* ↳ marks prompts sent while Claude was still working. */}
                {t.queued && <Text color="cyan">↳ </Text>}
                <EntryText
                  text={t.prompt}
                  width={Math.max(
                    4,
                    listWidth - 7 - (t.queued ? 2 : 0) - (marked ? 2 : 0) - (running || t.interrupted ? 2 : 0),
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
          ...(wrap ? [] : [{ text: "^←→ side", priority: 4 }]),
          { text: "↵ prompt", on: promptOpen },
          { text: "f follow", on: follow },
          ...markFooter(favorites.isMarked(current?.id), markedCount),
          { text: "t tools", on: showTools, priority: 2 },
          { text: "h think", on: showThinking, priority: 2 },
          { text: "w wrap", on: wrap, priority: 2 },
          { text: "c copy", priority: 2 },
          ...(imageCount > 0 ? [{ text: `o ${plural(imageCount, "image")}`, priority: 3 }] : []),
          { text: "1-5 view", priority: 1 },
        ]
      }
    />
  );
}
