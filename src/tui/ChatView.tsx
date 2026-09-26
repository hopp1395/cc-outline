import { basename } from "node:path";
import clipboard from "clipboardy";
import { Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import wrapAnsi from "wrap-ansi";
import { renderMarkdown } from "../render/markdown.js";
import { turnMarkdown, type Turn } from "../transcript/parse.js";
import { List, Screen, truncate, useScroll, type Layout } from "./layout.js";
import { Preview } from "./Preview.js";
import { useSessionPath, useTranscript } from "./useTranscript.js";

interface Props {
  cwd: string;
  sessionId?: string;
  layout: Layout;
  active: boolean;
}

const dim = (s: string) => `\u001b[2m${s}\u001b[22m`;
const cyan = (s: string) => `\u001b[36m${s}\u001b[39m`;

function promptHeader(turn: Turn, width: number): string[] {
  const lines = turn.prompt.split("\n");
  const shown = lines.slice(0, 6).join("\n") + (lines.length > 6 ? "\n…" : "");
  const wrapped = wrapAnsi(shown, width - 2, { hard: true }).split("\n");
  return [
    ...wrapped.map((l, i) => (i === 0 ? cyan("❯ ") : "  ") + dim(l)),
    dim("─".repeat(width)),
    "",
  ];
}

function time(ts?: string): string {
  if (!ts) return "     ";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ChatView({ cwd, sessionId, layout, active }: Props) {
  const path = useSessionPath(cwd, sessionId);
  const { turns, version } = useTranscript(path);
  const { listWidth, previewWidth, bodyHeight } = layout;

  const [selected, setSelected] = useState(0);
  const [follow, setFollow] = useState(true);
  const [listFocused, setListFocused] = useState(true);
  const [showTools, setShowTools] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [flash, setFlash] = useState<string>();

  const last = turns.length - 1;
  const current = turns[Math.min(selected, Math.max(0, last))];

  const lines = useMemo(() => {
    if (!current) return [];
    const body = turnMarkdown(current, { tools: showTools, thinking: showThinking });
    const rendered = body ? renderMarkdown(body, previewWidth) : [dim("(no text output yet)")];
    return [...promptHeader(current, previewWidth), ...rendered];
  }, [current, version, previewWidth, showTools, showThinking]);
  const scroll = useScroll(lines.length, bodyHeight);

  useEffect(() => {
    if (follow && last >= 0 && selected !== last) {
      setSelected(last);
      scroll.set(0);
    }
  }, [follow, last]);

  // A new session starts with an empty transcript: reset the view.
  useEffect(() => {
    setSelected(0);
    scroll.set(0);
    setFollow(true);
  }, [path]);

  const select = (index: number) => {
    const next = Math.max(0, Math.min(last, index));
    setSelected(next);
    scroll.set(0);
    setFollow(next === last);
  };
  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(undefined), 2000);
  };

  useInput(
    (input, key) => {
      if (key.tab) return setListFocused((f) => !f);
      if (key.upArrow || input === "k") return listFocused ? select(selected - 1) : scroll.by(-1);
      if (key.downArrow || input === "j") return listFocused ? select(selected + 1) : scroll.by(1);
      if (input === "p") return select(selected - 1);
      if (input === "n") return select(selected + 1);
      if (key.pageUp || input === "b") return scroll.by(-(bodyHeight - 2));
      if (key.pageDown || input === " ") return scroll.by(bodyHeight - 2);
      if (key.ctrl && input === "u") return scroll.by(-Math.floor(bodyHeight / 2));
      if (key.ctrl && input === "d") return scroll.by(Math.floor(bodyHeight / 2));
      if (key.home) return scroll.set(0);
      if (key.end) return scroll.set(scroll.max);
      if (input === "g") return select(0);
      if (input === "G") return select(last);
      if (input === "f") {
        setFollow((f) => !f);
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
          {showTools && <Text color="yellow"> · tools</Text>}
          {showThinking && <Text color="magenta"> · thinking</Text>}
        </>
      }
      list={
        <List
          items={turns}
          selected={selected}
          height={bodyHeight}
          focused={listFocused}
          empty="Waiting for prompts…"
          itemKey={(t, i) => t.id + i}
          render={(t, isSelected) => (
            <>
              <Text dimColor={!isSelected}>{time(t.timestamp)} </Text>
              {truncate(t.prompt, Math.max(4, listWidth - 7))}
            </>
          )}
        />
      }
      preview={
        path ? (
          <Preview lines={lines} scroll={scroll.scroll} width={previewWidth} height={bodyHeight} />
        ) : (
          <Text dimColor>No Claude Code session found for {cwd}</Text>
        )
      }
      footer={
        flash ??
        "↑↓/jk move · tab focus · space/b page · n/p turn · g/G first/last · f follow · t tools · h thinking · c copy · 1/2 view · q quit"
      }
    />
  );
}
