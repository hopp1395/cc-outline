import { Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseDiff } from "../git/diff.js";
import { fileDiff, listChanges, repoRoot, type FileChange } from "../git/git.js";
import { renderDiff } from "../render/diff.js";
import { List, Screen, truncate, useScroll, type Layout } from "./layout.js";
import { Preview } from "./Preview.js";

interface Props {
  cwd: string;
  layout: Layout;
  active: boolean;
}

const STATUS_COLOR: Record<string, string> = {
  M: "yellow",
  A: "green",
  "?": "green",
  D: "red",
  R: "blue",
  C: "blue",
  U: "magenta",
};

const POLL_MS = 2000;

export function GitView({ cwd, layout, active }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const [root, setRoot] = useState<string | null>();
  const [files, setFiles] = useState<FileChange[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [diffText, setDiffText] = useState("");
  const [listFocused, setListFocused] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    repoRoot(cwd).then((r) => setRoot(r ?? null));
  }, [cwd]);

  const selectedIndex = Math.max(0, files.findIndex((f) => f.path === selectedPath));
  const current = files[selectedIndex];

  const currentRef = useRef(current);
  currentRef.current = current;
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (!root || busy.current) return;
    busy.current = true;
    try {
      const next = await listChanges(root);
      setFiles((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      const file = next.find((f) => f.path === currentRef.current?.path) ?? next[0];
      setSelectedPath(file?.path);
      setDiffText(file ? await fileDiff(root, file) : "");
      setError(undefined);
    } catch (err) {
      setError((err as Error).message.split("\n")[0]);
    } finally {
      busy.current = false;
    }
  }, [root]);

  // Poll only while visible; Claude edits files between prompts, so this keeps the view current.
  useEffect(() => {
    if (!active || !root) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, root, refresh]);

  // Load the diff as soon as the selection changes instead of waiting for the next poll.
  useEffect(() => {
    if (!root || !current) return;
    let cancelled = false;
    fileDiff(root, current).then(
      (text) => !cancelled && setDiffText(text),
      (err: Error) => !cancelled && setError(err.message.split("\n")[0]),
    );
    return () => {
      cancelled = true;
    };
  }, [root, current?.path]);

  const rendered = useMemo(
    () => (current ? renderDiff(parseDiff(diffText), current.path, previewWidth) : { lines: [], hunkStarts: [] }),
    [diffText, current?.path, previewWidth],
  );
  const scroll = useScroll(rendered.lines.length, bodyHeight);

  const select = (index: number) => {
    const file = files[Math.max(0, Math.min(files.length - 1, index))];
    if (!file || file.path === current?.path) return;
    setSelectedPath(file.path);
    scroll.set(0);
  };
  const jumpHunk = (dir: 1 | -1) => {
    const starts = rendered.hunkStarts;
    const target =
      dir === 1 ? starts.find((s) => s > scroll.scroll) : [...starts].reverse().find((s) => s < scroll.scroll);
    if (target !== undefined) scroll.set(target);
  };

  useInput(
    (input, key) => {
      if (key.tab) return setListFocused((f) => !f);
      if (key.upArrow || input === "k") return listFocused ? select(selectedIndex - 1) : scroll.by(-1);
      if (key.downArrow || input === "j") return listFocused ? select(selectedIndex + 1) : scroll.by(1);
      if (input === "p") return select(selectedIndex - 1);
      if (input === "n") return select(selectedIndex + 1);
      if (key.pageUp || input === "b") return scroll.by(-(bodyHeight - 2));
      if (key.pageDown || input === " ") return scroll.by(bodyHeight - 2);
      if (key.ctrl && input === "u") return scroll.by(-Math.floor(bodyHeight / 2));
      if (key.ctrl && input === "d") return scroll.by(Math.floor(bodyHeight / 2));
      if (key.home) return scroll.set(0);
      if (key.end) return scroll.set(scroll.max);
      if (input === "g") return select(0);
      if (input === "G") return select(files.length - 1);
      if (input === "]") return jumpHunk(1);
      if (input === "[") return jumpHunk(-1);
      if (input === "r") return void refresh();
    },
    { isActive: active },
  );

  const totals = files.reduce((acc, f) => [acc[0] + (f.added ?? 0), acc[1] + (f.removed ?? 0)], [0, 0]);

  let preview;
  if (root === null) preview = <Text dimColor>{cwd} is not inside a git repository</Text>;
  else if (error) preview = <Text color="red">git: {error}</Text>;
  else if (!current) preview = <Text dimColor>Working tree clean</Text>;
  else preview = <Preview lines={rendered.lines} scroll={scroll.scroll} width={previewWidth} height={bodyHeight} />;

  return (
    <Screen
      layout={layout}
      mode="git"
      status={
        <Text dimColor>
          {files.length} files · <Text color="green">+{totals[0]}</Text> <Text color="red">-{totals[1]}</Text>
          {current && ` · ${current.path} · ${scroll.position}`}
        </Text>
      }
      list={
        <List
          items={files}
          selected={selectedIndex}
          height={bodyHeight}
          focused={listFocused}
          empty={root === undefined ? "Loading…" : "No changes"}
          itemKey={(f) => f.path}
          render={(f) => {
            const counts = f.added !== undefined ? ` +${f.added} -${f.removed}` : "";
            return (
              <>
                <Text color={STATUS_COLOR[f.status]}>{f.status} </Text>
                {truncate(f.path, Math.max(4, listWidth - 2 - counts.length))}
                <Text dimColor>{counts}</Text>
              </>
            );
          }}
        />
      }
      preview={preview}
      footer="↑↓/jk file · tab focus · space/b page · [/] hunk · n/p file · r refresh · 1/2 view · q quit"
    />
  );
}
