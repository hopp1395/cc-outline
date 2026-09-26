import { basename } from "node:path";
import clipboard from "clipboardy";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";
import wrapAnsi from "wrap-ansi";
import { renderMarkdown } from "../render/markdown.js";
import { turnMarkdown, type Turn } from "../transcript/parse.js";
import { Preview } from "./Preview.js";
import { TurnList } from "./TurnList.js";
import { useSessionPath, useTranscript } from "./useTranscript.js";

interface Props {
  cwd: string;
  sessionId?: string;
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

export function App({ cwd, sessionId }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const path = useSessionPath(cwd, sessionId);
  const { turns, version } = useTranscript(path);

  const [selected, setSelected] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [follow, setFollow] = useState(true);
  const [listFocused, setListFocused] = useState(true);
  const [showTools, setShowTools] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [flash, setFlash] = useState<string>();

  const listWidth = Math.min(40, Math.max(20, Math.floor(columns * 0.3)));
  const previewWidth = Math.max(20, columns - listWidth - 3);
  const bodyHeight = Math.max(3, rows - 2);

  const last = turns.length - 1;
  const current = turns[Math.min(selected, Math.max(0, last))];

  useEffect(() => {
    if (follow && last >= 0 && selected !== last) {
      setSelected(last);
      setScroll(0);
    }
  }, [follow, last]);

  // A new session starts with an empty transcript: reset the view.
  useEffect(() => {
    setSelected(0);
    setScroll(0);
    setFollow(true);
  }, [path]);

  const lines = useMemo(() => {
    if (!current) return [];
    const body = turnMarkdown(current, { tools: showTools, thinking: showThinking });
    const rendered = body ? renderMarkdown(body, previewWidth) : [dim("(no text output yet)")];
    return [...promptHeader(current, previewWidth), ...rendered];
  }, [current, version, previewWidth, showTools, showThinking]);

  const maxScroll = Math.max(0, lines.length - bodyHeight);
  const scrollBy = (delta: number) => setScroll((s) => Math.max(0, Math.min(maxScroll, s + delta)));
  const select = (index: number) => {
    const next = Math.max(0, Math.min(last, index));
    setSelected(next);
    setScroll(0);
    setFollow(next === last);
  };
  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(undefined), 2000);
  };

  useInput((input, key) => {
    if (input === "q" || key.escape) return exit();
    if (key.tab) return setListFocused((f) => !f);
    if (key.upArrow || input === "k") return listFocused ? select(selected - 1) : scrollBy(-1);
    if (key.downArrow || input === "j") return listFocused ? select(selected + 1) : scrollBy(1);
    if (input === "p") return select(selected - 1);
    if (input === "n") return select(selected + 1);
    if (key.pageUp || input === "b") return scrollBy(-(bodyHeight - 2));
    if (key.pageDown || input === " ") return scrollBy(bodyHeight - 2);
    if (key.ctrl && input === "u") return scrollBy(-Math.floor(bodyHeight / 2));
    if (key.ctrl && input === "d") return scrollBy(Math.floor(bodyHeight / 2));
    if (key.home) return setScroll(0);
    if (key.end) return setScroll(maxScroll);
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
  });

  const session = path ? basename(path, ".jsonl").slice(0, 8) : "none";
  const position =
    lines.length > bodyHeight
      ? `${Math.round(((scroll + bodyHeight) / lines.length) * 100)}%`
      : "all";

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box width={columns}>
        <Text wrap="truncate">
          <Text bold color="cyan">ccmd</Text>
          <Text dimColor>
            {"  "}session {session} · {turns.length} turns · {position}
          </Text>
          {follow && <Text color="green"> · FOLLOW</Text>}
          {showTools && <Text color="yellow"> · tools</Text>}
          {showThinking && <Text color="magenta"> · thinking</Text>}
        </Text>
      </Box>
      <Box height={bodyHeight}>
        <TurnList
          turns={turns}
          selected={selected}
          width={listWidth}
          height={bodyHeight}
          focused={listFocused}
        />
        <Box
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderDimColor
          paddingLeft={1}
          height={bodyHeight}
        >
          {path ? (
            <Preview lines={lines} scroll={Math.min(scroll, maxScroll)} width={previewWidth} height={bodyHeight} />
          ) : (
            <Text dimColor>No Claude Code session found for {cwd}</Text>
          )}
        </Box>
      </Box>
      <Text dimColor wrap="truncate">
        {flash ??
          "↑↓/jk move · tab focus · space/b page · n/p turn · g/G first/last · f follow · t tools · h thinking · c copy · q quit"}
      </Text>
    </Box>
  );
}
