import { Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { parseDiff } from "../git/diff.js";
import {
  branchStatus,
  fileContent,
  fileDiff,
  listChanges,
  repoRoot,
  type BranchStatus,
  type FileChange,
  type FileContent,
} from "../git/git.js";
import { addedLines, renderDiff, renderFile, type RenderedDiff } from "../render/diff.js";
import {
  bold,
  handleNavigation,
  List,
  EntryText,
  previewHeader,
  rule,
  Screen,
  markFooter,
  markKeys,
  Star,
  wrapPath,
  type Layout,
} from "./layout.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
import { nextMarked } from "../favorites.js";
import { haystack } from "../filter.js";
import { useFocused } from "./focus.js";
import { useFavorites } from "./useFavorites.js";
import { useOnReload } from "./reload.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { useSetting } from "./useSetting.js";
import { openInDefaultApp } from "../open.js";
import { doubleClicks, useCtrlEnter } from "./openKey.js";

interface Props {
  cwd: string;
  layout: Layout;
  active: boolean;
  /** Reports whether the whole-file view is open, so Esc closes it instead of quitting. */
  onFileOpen?: (open: boolean) => void;
  /** The filter dialog opened or closed. */
  onTyping?: (typing: boolean) => void;
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

const STATUS_ANSI: Record<string, string> = { yellow: "33", green: "32", red: "31", blue: "34", magenta: "35" };

const STATUS_LABEL: Record<string, string> = {
  M: "modified",
  A: "added",
  "?": "untracked",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflict",
};

/**
 * Full path of the file above its diff, like the prompt above a chat answer.
 * The rule names what Enter switches to.
 */
function fileHeader(file: FileChange, width: number, showFile: boolean): string[] {
  const color = STATUS_ANSI[STATUS_COLOR[file.status]] ?? "39";
  const counts = file.added !== undefined ? ` · +${file.added} -${file.removed}` : "";
  const details = [(STATUS_LABEL[file.status] ?? file.status) + counts + (showFile ? " · whole file" : " · diff")];
  if (file.oldPath) details.push(`from ${file.oldPath}`);
  const header = previewHeader(file.path, width, {
    marker: `\u001b[${color}m${file.status}\u001b[39m `,
    style: bold,
    details,
    wrap: wrapPath,
  });
  return [...header.slice(0, -1), rule(width, showFile ? "↵ diff" : "↵ whole file")];
}

const dim = (s: string) => `\u001b[2m${s}\u001b[22m`;

const message = (text: string): RenderedDiff => ({ lines: [dim(text)], hunkStarts: [], gutterWidth: 0 });

function renderContent(
  content: FileContent | undefined,
  diffText: string,
  path: string,
  width: number,
  wrap: boolean,
): RenderedDiff {
  if (!content) return message("Loading…");
  if (content.kind === "deleted") return message("File was deleted; there is no content after the change.");
  if (content.kind === "binary") return message("Binary file");
  return renderFile(content.text, path, width, addedLines(parseDiff(diffText)), wrap);
}

/**
 * Branch with outgoing (↑, to push) and incoming (↓, to pull) commit counts.
 * Counts appear only with an upstream; incoming ones are as of the last fetch.
 */
function BranchInfo({ status, bold }: { status?: BranchStatus; bold: boolean }) {
  if (!status) return null;
  const count = (arrow: string, n: number, color: string) =>
    n > 0 ? (
      <Text color={color} bold={bold}>
        {` ${arrow}${n}`}
      </Text>
    ) : (
      <Text>{` ${arrow}${n}`}</Text>
    );
  return (
    <>
      <Text color="cyan">{status.branch ?? "(detached)"}</Text>
      {status.upstream && (
        <>
          {count("↑", status.ahead, "yellow")}
          {count("↓", status.behind, "magenta")}
        </>
      )}
      {" · "}
    </>
  );
}

const POLL_MS = 2000;
/** Columns moved per Ctrl+←/→ when lines are not wrapped. */
const HSCROLL_STEP = 8;

export function GitView({ cwd, layout, active, onFileOpen, onTyping }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const [root, setRoot] = useState<string | null>();
  const [files, setFiles] = useState<FileChange[]>([]);
  // Selection and each file's scroll position survive switching files and restarting the viewer.
  const positions = usePositions(cwd, "git");
  const [selectedPath, setSelectedPath] = useState<string | undefined>(positions.selected);
  const [diffText, setDiffText] = useState("");
  const [showFile, setShowFile] = useState(false);
  const [wrap, setWrap] = useSetting("wrap");
  const focused = useFocused();
  const [hscroll, setHscroll] = useState(0);
  const [content, setContent] = useState<FileContent>();
  const [error, setError] = useState<string>();
  // Marked files of the project, by path.
  const favorites = useFavorites(cwd, "files");
  const [branch, setBranch] = useState<BranchStatus>();
  const [flash, setFlash] = useState<string>();
  const [isDoubleClick] = useState(() => doubleClicks());
  const showFileRef = useRef(showFile);
  showFileRef.current = showFile;

  useEffect(() => {
    repoRoot(cwd).then((r) => setRoot(r ?? null));
  }, [cwd]);

  const selectedIndex = Math.max(0, files.findIndex((f) => f.path === selectedPath));
  // A file is found by its path; its details are the path it was renamed from and its status.
  const filter = useListFilter({
    items: files,
    text: (f) => ({ list: f.path, details: haystack([f.oldPath, STATUS_LABEL[f.status]]) }),
    selected: selectedIndex,
    select: (i) => select(i),
    layout,
    onTyping,
  });
  const current = filter.none ? undefined : files[selectedIndex];

  // The refresh keeps the selected file, also the one restored before the list was read.
  const selectedRef = useRef(selectedPath);
  selectedRef.current = selectedPath;
  useEffect(() => positions.select(selectedPath), [selectedPath]);
  // The refresh running, which another one waits for instead of starting a second.
  const running = useRef<Promise<void> | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!root) return;
    if (running.current) return running.current;
    const run = load(root);
    running.current = run;
    try {
      await run;
    } finally {
      running.current = undefined;
    }
  }, [root]);

  const load = async (root: string) => {
    try {
      const [next, nextBranch] = await Promise.all([listChanges(root), branchStatus(root)]);
      setFiles((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      setBranch((prev) => (JSON.stringify(prev) === JSON.stringify(nextBranch) ? prev : nextBranch));
      const file = next.find((f) => f.path === selectedRef.current) ?? next[0];
      setSelectedPath(file?.path);
      setDiffText(file ? await fileDiff(root, file) : "");
      if (file && showFileRef.current) {
        const next = await fileContent(root, file);
        setContent((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      }
      setError(undefined);
    } catch (err) {
      setError((err as Error).message.split("\n")[0]);
    }
  };

  // F5: the repository is looked up again (e.g. after git init), then read once the refresh running has ended.
  useOnReload(({ done }) => {
    let cancelled = false;
    void (async () => {
      try {
        const found = (await repoRoot(cwd)) ?? null;
        if (cancelled) return;
        if (found !== root) setRoot(found);
        else {
          await running.current;
          await refresh();
        }
      } finally {
        // Also when it failed: F5 is refused while a reload runs.
        done();
      }
    })();
    return () => {
      cancelled = true;
    };
  });

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

  // The whole file is only read while that view is open.
  useEffect(() => {
    setContent(undefined);
    if (!root || !current || !showFile) return;
    let cancelled = false;
    fileContent(root, current).then(
      (c) => !cancelled && setContent(c),
      (err: Error) => !cancelled && setError(err.message.split("\n")[0]),
    );
    return () => {
      cancelled = true;
    };
  }, [root, current?.path, showFile]);

  const header = useMemo(() => {
    if (!current) return [];
    const full = fileHeader(current, previewWidth, showFile);
    const fitted = fitHeader(full, bodyHeight);
    // Keep the labelled rule even when the header had to be shortened.
    return fitted.length < full.length ? [...fitted.slice(0, -1), full.at(-1)!] : fitted;
  }, [current, previewWidth, bodyHeight, showFile]);
  const rendered = useMemo(() => {
    if (!current) return message("");
    return showFile
      ? renderContent(content, diffText, current.path, previewWidth, wrap)
      : renderDiff(parseDiff(diffText), current.path, previewWidth, wrap);
  }, [diffText, content, current?.path, previewWidth, showFile, wrap]);
  const viewport = bodyHeightBelow(header, bodyHeight);
  // The diff and the whole file of a file each keep their own position.
  const scroll = positions.scroll(current && (showFile ? `${current.path}#file` : current.path), rendered.lines.length, viewport);

  // How far unwrapped lines can be shifted until the longest one ends at the right edge.
  const maxHscroll = useMemo(
    () => (wrap ? 0 : Math.max(0, ...rendered.lines.map((l) => stringWidth(l))) - previewWidth),
    [rendered, wrap, previewWidth],
  );
  const shift = (delta: number) => setHscroll((h) => Math.max(0, Math.min(maxHscroll, h + delta)));

  const select = (index: number) => {
    const file = files[Math.max(0, Math.min(files.length - 1, index))];
    if (!file || file.path === current?.path) return;
    setSelectedPath(file.path);
    setHscroll(0);
  };
  const toggleFile = (open: boolean) => {
    setShowFile(open);
    onFileOpen?.(open);
    setHscroll(0);
  };
  /** Selects the next or previous marked file. */
  const jumpMark = (dir: 1 | -1) => {
    const target = nextMarked(
      filter.markIds(files.map((f) => f.path)),
      favorites.marks,
      selectedIndex,
      dir,
    );
    if (target !== undefined) select(target);
  };
  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(undefined), 2000);
  };
  /** Opens the selected file as it is now in the app the system uses for it. */
  const openExternal = () => {
    if (!root || !current) return;
    const file = join(root, current.path);
    if (!existsSync(file)) return notify(`${current.path} no longer exists`);
    openInDefaultApp(file);
    notify(`opened ${current.path}`);
  };
  const jumpHunk = (dir: 1 | -1) => {
    const starts = rendered.hunkStarts;
    // Once scrolled, the first row is the "▲ more" indicator, so the first readable line is one further down.
    const top = scroll.scroll > 0 ? scroll.scroll + 1 : 0;
    const target = dir === 1 ? starts.find((s) => s > top) : [...starts].reverse().find((s) => s < top);
    // Scroll one line less so the hunk header lands below the indicator.
    if (target !== undefined) scroll.set(Math.max(0, target - 1));
  };

  useInput(
    (input, key) => {
      if (filter.handleKey(input, key)) return;
      // Checked first because plain ↑/↓ switch files.
      const mark = markKeys(input, key);
      if (mark === "toggle") return current && favorites.toggle(current.path);
      if (mark) return jumpMark(mark);
      if (key.ctrl && (key.leftArrow || key.rightArrow)) return shift(key.leftArrow ? -HSCROLL_STEP : HSCROLL_STEP);
      if (input === "w") {
        setWrap((w) => !w);
        return setHscroll(0);
      }
      const nav = { ...filter.nav, scroll, page: viewport - 2 };
      if (handleNavigation(input, key, nav)) return;
      if (key.return && current) return openExternal();
      if (key.escape && showFile) return toggleFile(false);
      if (input === "]") return jumpHunk(1);
      if (input === "[") return jumpHunk(-1);
    },
    { isActive: active && !filter.open },
  );
  useCtrlEnter(() => current && toggleFile(!showFile), active && !filter.open);

  const markedCount = files.filter((f) => favorites.isMarked(f.path)).length;
  const totals = files.reduce((acc, f) => [acc[0] + (f.added ?? 0), acc[1] + (f.removed ?? 0)], [0, 0]);

  let preview;
  if (root === null) preview = <Text dimColor>{cwd} is not inside a git repository</Text>;
  else if (error) preview = <Text color="red">git: {error}</Text>;
  else if (filter.none) preview = <Text dimColor>No file matches the filter</Text>;
  else if (!current) preview = <Text dimColor>Working tree clean</Text>;
  else
    preview = (
      <Preview
        onWheel={(d) => scroll.by(d)}
        header={header}
        lines={rendered.lines}
        scroll={scroll.scroll}
        width={previewWidth}
        height={bodyHeight}
        hscroll={Math.min(hscroll, maxHscroll)}
        frozen={rendered.gutterWidth}
        pinned={showFile ? [] : rendered.hunkStarts}
      />
    );

  return (
    <>
    <Screen
      layout={layout}
      mode="git"
      status={
        <Text dimColor={!focused}>
          <BranchInfo status={branch} bold={focused} />
          {filter.count(files.length)} files · <Text color="green">+{totals[0]}</Text> <Text color="red">-{totals[1]}</Text>
          {current && ` · ${scroll.position}`}
          {markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
          {!wrap && hscroll > 0 && ` · → ${Math.min(hscroll, maxHscroll)} cols`}
        </Text>
      }
      list={
        <List
            onPick={select}
          onClick={(i) => isDoubleClick(i) && openExternal()}
          items={files}
          shown={filter.shown}
          filter={filter.banner}
          selected={selectedIndex}
          height={bodyHeight}
          empty={filter.empty ?? (root === undefined ? "Loading…" : "No changes")}
          itemKey={(f) => f.path}
          render={(f, isSelected) => {
            const marked = favorites.isMarked(f.path);
            const counts = f.added !== undefined ? ` +${f.added} -${f.removed}` : "";
            const nameWidth = Math.max(4, listWidth - 2 - counts.length - (marked ? 2 : 0));
            return (
              <>
                {marked && <Star />}
                <Text color={STATUS_COLOR[f.status]}>{f.status} </Text>
                <EntryText text={f.path} width={nameWidth} selected={isSelected} active={active} />
                <Text dimColor>{counts}</Text>
              </>
            );
          }}
        />
      }
      preview={preview}
      footer={flash ?? [
        { text: "↑↓ file", priority: 4 },
        { text: "PgUp/Dn scroll", priority: 1 },
        ...(wrap ? [] : [{ text: "^←→ side", priority: 4 }]),
        { text: "^↵ file", on: showFile },
        { text: "↵ open", priority: 1 },
        ...markFooter(favorites.isMarked(current?.path), markedCount),
        ...filter.footer,
        { text: showFile ? "[/] change" : "[/] hunk" },
        { text: "w wrap", on: wrap, priority: 2 },
        { text: "1-6/tab view", priority: 1 },
      ]}
    />
    {filter.dialog}
    </>
  );
}
