import { Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { parseDiff } from "../git/diff.js";
import {
  branchStatus,
  fileContent,
  fileDiff,
  listChanges,
  recentCommits,
  type BranchStatus,
  type Commit,
  type FileChange,
  type FileContent,
} from "../git/git.js";
import { findRepos, nestedPaths, REPO_DEPTH, withoutNested, type Repo } from "../git/repos.js";
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
import { ruleText } from "./days.js";
import { bodyHeightBelow,fitHeader, Preview } from "./Preview.js";
import { haystack } from "../filter.js";
import { useFocused } from "./focus.js";
import { useFavorites } from "./useFavorites.js";
import { useOnReload } from "./reload.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { useSetting } from "./useSetting.js";
import { openInDefaultApp } from "../open.js";
import { doubleClicks, useCtrlEnter } from "./openKey.js";
import { isLoadMore, LOAD_MORE, LoadMoreRow, type LoadMore } from "./loadMore.js";

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

/** What was read of a repository. */
export interface RepoState {
  files: FileChange[];
  branch?: BranchStatus;
  /** git failed in it. */
  error?: string;
}

/**
 * An entry of the list: a changed file of a repository, or (`file` undefined)
 * the one entry of a repository without changes. `key` is its path from the
 * base (`tools/bar/src/x.ts`; a file of the base's repository by its own path,
 * as before there were several), which positions and marks are stored under.
 */
export interface GitEntry {
  repo: Repo;
  file?: FileChange;
  key: string;
}

type Item = GitEntry | LoadMore;

const LOAD_MORE_KEY = "load-more";
const keyOf = (item: Item) => (isLoadMore(item) ? LOAD_MORE_KEY : item.key);
const isEntry = (item: Item | undefined): item is GitEntry => item !== undefined && !isLoadMore(item);

/** The key of a file of `repo`: its path from the base. */
export const fileKey = (repo: Repo, path: string) => (repo.rel ? `${repo.rel}/${path}` : path);
/** The key of a repository's entry, the separator above its files. */
export const repoKey = (repo: Repo) => `repo:${repo.rel}`;

/** How many repositories are read without load more, every `POLL_MS`; the others every `SLOW_EVERY` polls. */
export const REPO_LIMIT = 10;

/**
 * The list's entries: per repository its own entry (drawn as the separator,
 * with the last commits as its preview), then its changed files, then load more while repositories past `REPO_LIMIT` are
 * not read. A repository not read yet has no entries.
 */
export function gitEntries(repos: Repo[], states: Record<string, RepoState>, loadAll: boolean): Item[] {
  const items: Item[] = [];
  for (const repo of loadAll ? repos : repos.slice(0, REPO_LIMIT)) {
    const state = states[repo.root];
    if (!state) continue;
    items.push({ repo, key: repoKey(repo) });
    for (const file of state.files) items.push({ repo, file, key: fileKey(repo, file.path) });
  }
  const unread = repos.slice(REPO_LIMIT).some((r) => !states[r.root]);
  if (repos.length > REPO_LIMIT && (!loadAll || unread)) items.push(LOAD_MORE);
  return items;
}

/** The separator of a repository: its path from the base (the base's own by its folder name) and its branch. */
export function repoLabel(repo: Repo, base: string, branch: BranchStatus | undefined): string {
  const name = repo.rel || basename(base) || base;
  return branch ? `${name} · ${branch.branch ?? "(detached)"}` : name;
}

/**
 * Full path of the file above its diff, like the prompt above a chat answer.
 * The rule names what Enter switches to.
 */
function fileHeader(file: FileChange, path: string, width: number, showFile: boolean): string[] {
  const color = STATUS_ANSI[STATUS_COLOR[file.status]] ?? "39";
  const counts = file.added !== undefined ? ` · +${file.added} -${file.removed}` : "";
  const details = [(STATUS_LABEL[file.status] ?? file.status) + counts + (showFile ? " · whole file" : " · diff")];
  if (file.oldPath) details.push(`from ${file.oldPath}`);
  const header = previewHeader(path, width, {
    marker: `\u001b[${color}m${file.status}\u001b[39m `,
    style: bold,
    details,
    wrap: wrapPath,
  });
  return [...header.slice(0, -1), rule(width, showFile ? "↵ diff" : "↵ whole file")];
}

/** The folder of a repository without changes above its preview, with its branch. */
function repoHeader(repo: Repo, branch: BranchStatus | undefined, width: number): string[] {
  const details: string[] = [];
  if (branch) {
    const name = branch.branch ?? "(detached)";
    details.push(branch.upstream ? `${name} · ↑${branch.ahead} ↓${branch.behind} · ${branch.upstream}` : name);
  }
  const header = previewHeader(repo.root, width, { marker: "  ", style: bold, details, wrap: wrapPath });
  return [...header.slice(0, -1), rule(width, "↵ open folder")];
}

const dim = (s: string) => `\u001b[2m${s}\u001b[22m`;
const yellow = (s: string) => `\u001b[33m${s}\u001b[39m`;

const message = (text: string): RenderedDiff => ({ lines: [dim(text)], hunkStarts: [], gutterWidth: 0 });

/** The most commits a repository's preview lists; one more is read to tell whether there are older ones. */
export const COMMIT_LIMIT = 100;

/** The preview of a repository: its changes in one line, and its last commits (up to `COMMIT_LIMIT`, of `COMMIT_LIMIT + 1` read). */
export function repoLines(state: RepoState | undefined, commits: Commit[] | undefined): string[] {
  if (state?.error) return [`\u001b[31mgit: ${state.error}\u001b[39m`];
  const files = state?.files ?? [];
  const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
  const lines = [
    files.length === 0
      ? dim("No changes")
      : `${files.length} file${files.length === 1 ? "" : "s"} · \u001b[32m+${added}\u001b[39m \u001b[31m-${removed}\u001b[39m`,
  ];
  if (commits === undefined) return lines;
  if (commits.length === 0) return [...lines, "", dim("No commits yet")];
  const shown = commits.slice(0, COMMIT_LIMIT);
  const older = commits.length > COMMIT_LIMIT ? [dim("older commits: ") + yellow("git log")] : [];
  return [
    ...lines,
    "",
    `Last ${shown.length} commit${shown.length === 1 ? "" : "s"}:`,
    ...shown.map((c) => `${yellow(c.hash)}  ${dim(c.when)}  ${c.subject}`),
    ...older,
  ];
}

/** The preview of load more: how many repositories are read and what Enter does. */
function loadMoreLines(total: number, base: string, loading: boolean): string[] {
  return [
    `The list shows the first ${REPO_LIMIT} of the ${total} repositories in ${base} and the folders below.`,
    "",
    loading
      ? "Reading the others…"
      : `Enter or a click reads the other ${total - REPO_LIMIT}, until the viewer restarts. They are read again every 10 s, the one of the selected entry every 2 s.`,
  ];
}

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
/** The repositories past `REPO_LIMIT` are read every fifth poll (10 s). */
const SLOW_EVERY = 5;
/** The folders are searched for repositories every 15th poll (30 s). */
const DISCOVER_EVERY = 15;
/** Columns moved per Ctrl+←/→ when lines are not wrapped. */
const HSCROLL_STEP = 8;

async function readRepo(repo: Repo, repos: Repo[]): Promise<RepoState> {
  try {
    const [files, branch] = await Promise.all([listChanges(repo.root), branchStatus(repo.root)]);
    return { files: withoutNested(files, nestedPaths(repo, repos)), branch };
  } catch (err) {
    return { files: [], error: (err as Error).message.split("\n")[0] };
  }
}

export function GitView({ cwd, layout, active, onFileOpen, onTyping }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const [nested] = useSetting("gitNestedRepos");
  // The repositories found (null: none), the folder they were searched from, and what was read of each.
  const [repos, setRepos] = useState<Repo[] | null>();
  const [base, setBase] = useState(cwd);
  const [states, setStates] = useState<Record<string, RepoState>>({});
  // Load more: all repositories are read, until the viewer restarts.
  const [loadAll, setLoadAll] = useState(false);
  // Selection and each file's scroll position survive switching files and restarting the viewer.
  const positions = usePositions(cwd, "git");
  const [selectedKey, setSelectedKey] = useState<string | undefined>(positions.selected);
  const [diffText, setDiffText] = useState("");
  const [showFile, setShowFile] = useState(false);
  const [wrap, setWrap] = useSetting("wrap");
  const focused = useFocused();
  const [hscroll, setHscroll] = useState(0);
  const [content, setContent] = useState<FileContent>();
  // The last commits of the selected repository entry, with the root they were read from.
  const [commitsOf, setCommitsOf] = useState<{ root: string; commits: Commit[] }>();
  const [error, setError] = useState<string>();
  // Marked entries of the project, by key.
  const favorites = useFavorites(cwd, "files");
  const [flash, setFlash] = useState<string>();
  const [isDoubleClick] = useState(() => doubleClicks());
  const showFileRef = useRef(showFile);
  showFileRef.current = showFile;

  const items = useMemo(() => gitEntries(repos ?? [], states, loadAll), [repos, states, loadAll]);
  const shownRepos = repos ? (loadAll ? repos : repos.slice(0, REPO_LIMIT)) : [];
  // Every repository shown has been read: only then a selection that is gone moves on.
  const ready = repos === null || (repos !== undefined && shownRepos.every((r) => states[r.root]));
  const selectedIndex = Math.max(0, items.findIndex((e) => keyOf(e) === selectedKey));
  const labelOf = (repo: Repo) => repoLabel(repo, base, states[repo.root]?.branch);
  // An entry is found by its path from the base, so also by its repository's; its details are the path it was renamed from, its status and branch.
  const filter = useListFilter({
    items,
    text: (e) =>
      isLoadMore(e)
        ? { list: "", details: "" }
        : e.file
          ? { list: e.key, details: haystack([e.file.oldPath, STATUS_LABEL[e.file.status], labelOf(e.repo)]) }
          : // The separator stays while its name or one of its files matches.
            { list: haystack([labelOf(e.repo), ...(states[e.repo.root]?.files ?? []).map((f) => fileKey(e.repo, f.path))]), details: "" },
    selected: selectedIndex,
    select: (i) => select(i),
    layout,
    onTyping,
    keep: (e) => isLoadMore(e),
    marked: (e) => isEntry(e) && e.file !== undefined && favorites.isMarked(e.key),
    restoreCopy: positions.pinned ? (e) => keyOf(e) === positions.selected : undefined,
  });
  const picked = filter.none ? undefined : items[selectedIndex];
  const current = isEntry(picked) ? picked : undefined;
  const onLoadMore = isLoadMore(picked);
  const currentFile = current?.file;
  const currentState = current && states[current.repo.root];

  // The refresh keeps the selected entry, also the one restored before the list was read.
  const currentRef = useRef(current);
  currentRef.current = current;
  const reposRef = useRef<Repo[] | null | undefined>(undefined);
  const loadAllRef = useRef(loadAll);
  loadAllRef.current = loadAll;
  useEffect(() => {
    if (selectedKey !== LOAD_MORE_KEY) positions.select(selectedKey, undefined, filter.copySelected);
  }, [selectedKey, filter.copySelected]);
  // The refresh running, which another one waits for instead of starting a second.
  const running = useRef<Promise<void> | undefined>(undefined);

  /**
   * Reads the repositories: with `discover` it searches for them first, with `all`
   * it reads every one shown, else only the first `REPO_LIMIT` and the selected one's.
   */
  const refresh = useCallback(
    async (opts: { discover?: boolean; all?: boolean }) => {
      if (running.current) return running.current;
      const run = load(opts);
      running.current = run;
      try {
        await run;
      } finally {
        running.current = undefined;
      }
    },
    [cwd, nested],
  );

  /** Reads a repository's last commits, if it is still the selected entry once they arrive; unchanged ones keep the preview as it is. */
  const readCommits = async (root: string) => {
    const commits = await recentCommits(root, COMMIT_LIMIT + 1);
    const entry = currentRef.current;
    if (!entry || entry.file || entry.repo.root !== root) return;
    setCommitsOf((prev) => (prev?.root === root && JSON.stringify(prev.commits) === JSON.stringify(commits) ? prev : { root, commits }));
  };

  const load = async ({ discover, all }: { discover?: boolean; all?: boolean }) => {
    let list = reposRef.current;
    if (discover || list === undefined) {
      const found = await findRepos(cwd, nested);
      list = found.repos.length > 0 ? found.repos : null;
      if (JSON.stringify(list) !== JSON.stringify(reposRef.current)) {
        reposRef.current = list;
        setRepos(list);
      }
      setBase(found.base);
    }
    if (!list) return;
    const shown = loadAllRef.current ? list : list.slice(0, REPO_LIMIT);
    const selectedRoot = currentRef.current?.repo.root;
    const targets = shown.filter((r, i) => all || i < REPO_LIMIT || r.root === selectedRoot);
    const read = await Promise.all(targets.map(async (r) => [r.root, await readRepo(r, list)] as const));
    setStates((prev) => {
      let next = prev;
      for (const [root, state] of read) {
        if (JSON.stringify(prev[root]) === JSON.stringify(state)) continue;
        if (next === prev) next = { ...prev };
        next[root] = state;
      }
      return next;
    });
    // The selected file may have changed again since it was shown, a selected repository got new commits.
    const entry = currentRef.current;
    if (entry && !entry.file) await readCommits(entry.repo.root);
    const state = entry && read.find(([root]) => root === entry.repo.root)?.[1];
    const file = entry?.file && state?.files.find((f) => f.path === entry.file!.path);
    if (!entry || !file) return setError(undefined);
    try {
      setDiffText(await fileDiff(entry.repo.root, file));
      if (showFileRef.current) {
        const next = await fileContent(entry.repo.root, file);
        setContent((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      }
      setError(undefined);
    } catch (err) {
      setError((err as Error).message.split("\n")[0]);
    }
  };

  // A selection that is gone (committed, reverted, a repository removed) moves to the first entry;
  // after load more, to the first one of the repositories read since.
  useEffect(() => {
    if (!ready || items.some((e) => keyOf(e) === selectedKey)) return;
    const after = selectedKey === LOAD_MORE_KEY && repos ? repos[REPO_LIMIT]?.root : undefined;
    const next = items.find((e) => isEntry(e) && e.repo.root === after) ?? items.find(isEntry);
    setSelectedKey(next ? keyOf(next) : undefined);
  }, [ready, items, selectedKey]);

  // F5: the repositories are searched again (e.g. after git init or a clone), then all are read.
  useOnReload(({ done }) => {
    let cancelled = false;
    void (async () => {
      try {
        await running.current;
        if (!cancelled) await refresh({ discover: true, all: true });
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
    if (!active) return;
    let tick = 0;
    void refresh({ discover: true, all: true });
    const timer = setInterval(() => {
      tick++;
      void refresh({ discover: tick % DISCOVER_EVERY === 0, all: tick % SLOW_EVERY === 0 });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  // Load the diff as soon as the selection changes instead of waiting for the next poll.
  useEffect(() => {
    if (!current || !currentFile) return setDiffText("");
    let cancelled = false;
    fileDiff(current.repo.root, currentFile).then(
      (text) => !cancelled && setDiffText(text),
      (err: Error) => !cancelled && setError(err.message.split("\n")[0]),
    );
    return () => {
      cancelled = true;
    };
  }, [current?.key]);

  // The whole file is only read while that view is open.
  useEffect(() => {
    setContent(undefined);
    if (!current || !currentFile || !showFile) return;
    let cancelled = false;
    fileContent(current.repo.root, currentFile).then(
      (c) => !cancelled && setContent(c),
      (err: Error) => !cancelled && setError(err.message.split("\n")[0]),
    );
    return () => {
      cancelled = true;
    };
  }, [current?.key, showFile]);

  // A repository entry shows its last commits, read at once when it is selected and again with each refresh.
  const repoRoot = current && !currentFile ? current.repo.root : undefined;
  const commits = repoRoot && commitsOf?.root === repoRoot ? commitsOf.commits : undefined;
  useEffect(() => {
    if (repoRoot) void readCommits(repoRoot);
  }, [repoRoot]);

  // The whole file closes when the selection is no file.
  useEffect(() => {
    if (showFile && !currentFile && ready) toggleFile(false);
  }, [showFile, currentFile, ready]);

  const header = useMemo(() => {
    if (!current) return [];
    const full = currentFile ? fileHeader(currentFile, current.key, previewWidth, showFile) : repoHeader(current.repo, currentState?.branch, previewWidth);
    const fitted = fitHeader(full, bodyHeight);
    // Keep the labelled rule even when the header had to be shortened.
    return fitted.length < full.length ? [...fitted.slice(0, -1), full.at(-1)!] : fitted;
  }, [current, currentFile, currentState?.branch, previewWidth, bodyHeight, showFile]);
  const rendered = useMemo(() => {
    if (onLoadMore && repos) return { ...message(""), lines: loadMoreLines(repos.length, base, loadAll) };
    if (!current) return message("");
    if (!currentFile) return { ...message(""), lines: repoLines(currentState, commits) };
    return showFile
      ? renderContent(content, diffText, currentFile.path, previewWidth, wrap)
      : renderDiff(parseDiff(diffText), currentFile.path, previewWidth, wrap);
  }, [diffText, content, current?.key, currentState, commits, onLoadMore, repos, base, loadAll, previewWidth, showFile, wrap]);
  const viewport = bodyHeightBelow(header, bodyHeight);
  // The diff and the whole file of a file each keep their own position.
  const scroll = positions.scroll(current && (showFile ? `${current.key}#file` : current.key), rendered.lines.length, viewport);

  // How far unwrapped lines can be shifted until the longest one ends at the right edge.
  const maxHscroll = useMemo(
    () => (wrap ? 0 : Math.max(0, ...rendered.lines.map((l) => stringWidth(l))) - previewWidth),
    [rendered, wrap, previewWidth],
  );
  const shift = (delta: number) => setHscroll((h) => Math.max(0, Math.min(maxHscroll, h + delta)));

  const select = (index: number) => {
    const item = items[Math.max(0, Math.min(items.length - 1, index))];
    if (!item || keyOf(item) === selectedKey) return;
    setSelectedKey(keyOf(item));
    setHscroll(0);
  };
  const toggleFile = (open: boolean) => {
    setShowFile(open);
    onFileOpen?.(open);
    setHscroll(0);
  };
  /** Load more: the repositories past the first ones are read from now on. */
  const loadMore = () => {
    if (loadAll) return;
    setLoadAll(true);
    loadAllRef.current = true;
    void (async () => {
      await running.current;
      await refresh({ all: true });
    })();
  };
  /** Selects the next or previous marked entry. */
  const jumpMark = (dir: 1 | -1) => {
    const target = filter.nextMark(dir);
    if (target !== undefined) select(target);
  };
  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(undefined), 2000);
  };
  /** Opens the selected file as it is now in the app the system uses for it, or the folder of a repository without changes. */
  const openExternal = () => {
    if (!current) return;
    const target = currentFile ? join(current.repo.root, currentFile.path) : current.repo.root;
    const name = currentFile ? current.key : current.repo.rel || basename(base);
    if (!existsSync(target)) return notify(`${name} no longer exists`);
    openInDefaultApp(target);
    notify(`opened ${name}`);
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
      if (mark === "toggle") {
        if (!currentFile) return;
        if (favorites.isMarked(current!.key)) filter.unmarking(selectedIndex);
        return favorites.toggle(current!.key);
      }
      if (mark) return jumpMark(mark);
      if (key.ctrl && (key.leftArrow || key.rightArrow)) return shift(key.leftArrow ? -HSCROLL_STEP : HSCROLL_STEP);
      if (input === "w") {
        setWrap((w) => !w);
        return setHscroll(0);
      }
      const nav = { ...filter.nav, scroll, page: viewport - 2 };
      if (handleNavigation(input, key, nav)) return;
      if (key.return && onLoadMore) return loadMore();
      if (key.return && current) return openExternal();
      if (key.escape && showFile) return toggleFile(false);
      if (input === "]") return jumpHunk(1);
      if (input === "[") return jumpHunk(-1);
    },
    { isActive: active && !filter.open },
  );
  useCtrlEnter(() => currentFile && toggleFile(!showFile), active && !filter.open);

  const entries = items.filter(isEntry);
  const changed = entries.filter((e) => e.file);
  const markedCount = changed.filter((e) => favorites.isMarked(e.key)).length;
  const totals = changed.reduce((acc, e) => [acc[0] + (e.file!.added ?? 0), acc[1] + (e.file!.removed ?? 0)], [0, 0]);
  // Files only: the entries of repositories without changes are none.
  const isFile = (i: number) => isEntry(items[i]) && (items[i] as GitEntry).file !== undefined;
  const fileCount = filter.shown ? `${filter.shown.filter(isFile).length}/${changed.length}` : String(changed.length);

  let preview;
  if (repos === null)
    preview = (
      <Text dimColor>
        {nested ? `No git repository in ${cwd} or up to ${REPO_DEPTH} levels below` : `${cwd} is not inside a git repository`}
      </Text>
    );
  else if (error && currentFile) preview = <Text color="red">git: {error}</Text>;
  else if (filter.none) preview = <Text dimColor>No file matches the filter</Text>;
  else if (!current && !onLoadMore) preview = <Text dimColor>{repos === undefined ? "Loading…" : "Working tree clean"}</Text>;
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

  const readMore = repos ? repos.slice(REPO_LIMIT).filter((r) => states[r.root]).length : 0;
  return (
    <>
    <Screen
      layout={layout}
      mode="git"
      status={
        <Text dimColor={!focused}>
          <BranchInfo status={currentState?.branch} bold={focused} />
          {repos && repos.length > 1 && `${repos.length} repos · `}
          {fileCount} files · <Text color="green">+{totals[0]}</Text> <Text color="red">-{totals[1]}</Text>
          {current && ` · ${scroll.position}`}
          {markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
          {!wrap && hscroll > 0 && ` · → ${Math.min(hscroll, maxHscroll)} cols`}
        </Text>
      }
      list={
        <List
          onPick={select}
          onClick={(i) => {
            if (isLoadMore(items[i])) return loadMore();
            if (isDoubleClick(i)) openExternal();
          }}
          items={items}
          shown={filter.shown}
          pinned={filter.pinned}
          filter={filter.banner}
          selected={selectedIndex}
          height={bodyHeight}
          empty={filter.empty ?? (repos === undefined || !ready ? "Loading…" : "No changes")}
          itemKey={keyOf}
          render={(e, isSelected, pinnedCopy) => {
            if (isLoadMore(e)) return <LoadMoreRow progress={loadAll && repos ? { done: readMore, total: repos.length - REPO_LIMIT } : undefined} />;
            // A repository's entry is its separator.
            if (!e.file)
              return (
                <Text dimColor={!isSelected}>
                  <EntryText text={ruleText(labelOf(e.repo), listWidth)} width={listWidth} selected={isSelected} active={active} />
                </Text>
              );
            const marked = favorites.isMarked(e.key);
            // A pinned copy stands apart from its repository's separator, so it names the repository.
            const prefix = pinnedCopy && e.repo.rel ? `${e.repo.rel}/` : "";
            const f = e.file;
            const counts = f.added !== undefined ? ` +${f.added} -${f.removed}` : "";
            const nameWidth = Math.max(4, listWidth - 2 - counts.length - (marked ? 2 : 0));
            return (
              <>
                {marked && <Star />}
                <Text color={STATUS_COLOR[f.status]}>{f.status} </Text>
                <EntryText text={prefix + f.path} width={nameWidth} selected={isSelected} active={active} />
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
        { text: onLoadMore ? "↵ more" : "↵ open", priority: 1 },
        ...markFooter(currentFile !== undefined && favorites.isMarked(current?.key), markedCount),
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
