import { homedir } from "node:os";
import { basename } from "node:path";
import { Text } from "ink";
import stringWidth from "string-width";
import { detectTerminal } from "../open.js";
import { settingsFile } from "../settings.js";
import { AUTHOR, LICENSE, VERSION } from "../version.js";
import { paneSwitchKey } from "./focus.js";
import { Dialog, type Layout, type Mode } from "./layout.js";

interface Props {
  layout: Layout;
  mode: Mode;
  cwd: string;
  /** Transcript of the shown session. */
  path?: string;
  /** Git repository root; null outside a repository, undefined while unknown. */
  gitRoot?: string | null;
}

/** Keys all lists share; each view lists them first. */
const LIST_KEYS = (entry: string): [string, string][] => [
  ["↑↓", `previous / next ${entry}`],
  ["Home End g G", `first / last ${entry}`],
  ["Space", `mark ${entry} ★`],
  ["⇧↑↓", "previous / next marked"],
  ["^F", "filter the list (again: clear)"],
  ["PgUp PgDn", "scroll by page"],
  ["^↑↓", "scroll by line"],
  ["^Home ^End", "top / bottom"],
];

const COMMON_KEYS: [string, string][] = [
  ["1 – 6", "chat / changes / plan / sessions / monitor / settings"],
  ["Tab ⇧Tab", "next / previous view"],
  ["click", "select / open a link"],
  ["wheel", "scroll"],
  ["p", "move: right / left / window"],
  ["i", "this info"],
  ["q", "quit"],
];

/** Keys of each view, shown in two columns. */
const KEYS: Record<Mode, [string, string][]> = {
  chat: [
    ...LIST_KEYS("turn"),
    ["s", "newest / oldest first"],
    ["↵", "full prompt"],
    ["ctrl+End", "jump to bottom"],
    ["f", "follow mode"],
    ["t", "tools: off / compact / full"],
    ["h", "thinking"],
    ["w", "wrap lines"],
    ["^←→", "scroll sideways"],
    ["c", "copy Markdown"],
    ["o", "open pasted images"],
    ["a A", "next / previous subagent"],
    ...COMMON_KEYS,
  ],
  git: [
    ...LIST_KEYS("file"),
    ["↵", "whole file / diff"],
    ["[ ]", "previous / next hunk"],
    ["w", "wrap lines"],
    ["^←→", "scroll sideways"],
    ["r", "refresh"],
    ...COMMON_KEYS,
  ],
  plan: [
    ...LIST_KEYS("plan"),
    ["s", "newest / oldest first"],
    ["↵", "changes to previous"],
    ["w", "wrap lines"],
    ["^←→", "scroll sideways"],
    ["c", "copy the plan"],
    ...COMMON_KEYS,
  ],
  sessions: [
    ...LIST_KEYS("session"),
    ["s", "newest / oldest first"],
    ["↵", "start in a new tab"],
    ["c", "copy resume command"],
    ["d Del", "move to trash"],
    ["u", "undo / restore"],
    ["T", "trash on / off"],
    ["a", "all projects / this one"],
    ["x X", "delete / empty trash"],
    ...COMMON_KEYS,
  ],
  settings: [
    ...LIST_KEYS("setting"),
    ["↵", "next value"],
    ["r", "back to the default"],
    ["R", "reset all"],
    ...COMMON_KEYS,
  ],
  monitor: [
    ...LIST_KEYS("day"),
    ["s", "newest / oldest first"],
    ["↵", "chart / table of responses"],
    ["v", "overall / speed / wait / responses"],
    ["m", "model"],
    ...COMMON_KEYS,
  ],
};

const VIEW_TITLES: Record<Mode, string> = { chat: "Chat", git: "Changes", plan: "Plan", sessions: "Sessions", settings: "Settings", monitor: "Monitor" };

const MAX_WIDTH = 78;
const LABEL_WIDTH = 11;
const KEY_WIDTH = 13;

/** Replaces the home directory with ~. */
function tilde(path: string): string {
  const home = homedir();
  return path.toLowerCase().startsWith(home.toLowerCase()) ? "~" + path.slice(home.length) : path;
}

/** Keeps the end of `text`, which is the telling part of a path. */
function truncateStart(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let out = "";
  for (const ch of [...text].reverse()) {
    if (stringWidth(ch + out) > width - 1) break;
    out = ch + out;
  }
  return "…" + out;
}

function terminalName(): string {
  const terminal = detectTerminal();
  return terminal === "tmux" ? "tmux" : terminal === "wt" ? "Windows Terminal" : "other";
}

/**
 * Modal box centred over the view: version, what is being shown, where the
 * data comes from, and the keys of the current view.
 */
export function InfoDialog({ layout, mode, cwd, path, gitRoot }: Props) {
  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Border (2) and padding (2).
  const inner = width - 4;
  const valueWidth = inner - LABEL_WIDTH;

  const row = (label: string, value: string) => (
    <Text key={label} wrap="truncate">
      <Text dimColor>{label.padEnd(LABEL_WIDTH)}</Text>
      {truncateStart(value, valueWidth)}
    </Text>
  );
  const heading = (text: string) => (
    <Text key={`heading:${text}`} bold color="cyan">
      {text}
    </Text>
  );

  const keys = KEYS[mode];
  const half = Math.ceil(keys.length / 2);
  const columnWidth = Math.floor(inner / 2);
  const keyCell = (entry?: [string, string]) =>
    entry ? (
      <>
        <Text color="yellow">{entry[0].padEnd(KEY_WIDTH)}</Text>
        <Text>{entry[1].padEnd(columnWidth - KEY_WIDTH).slice(0, columnWidth - KEY_WIDTH)}</Text>
      </>
    ) : null;

  const lines = [
    heading("Session"),
    row("Project", tilde(cwd)),
    row("Session", path ? basename(path, ".jsonl") : "none found"),
    row("Transcript", path ? tilde(path) : "–"),
    row("Git repo", gitRoot === undefined ? "…" : gitRoot === null ? "not a git repository" : tilde(gitRoot)),
    <Text key="gap1"> </Text>,
    heading("Viewer"),
    row("Terminal", `${terminalName()} · ${paneSwitchKey("left")} / ${paneSwitchKey("right")} switch panes`),
    row("Settings", tilde(settingsFile())),
    <Text key="gap2"> </Text>,
    heading(`Keys · ${VIEW_TITLES[mode]}`),
    ...Array.from({ length: half }, (_, i) => (
      <Text key={`k${i}`} wrap="truncate">
        {keyCell(keys[i])}
        {keyCell(keys[half + i])}
      </Text>
    )),
  ];

  // Title, author and blank line + content, plus the border.
  const height = Math.min(layout.rows - 2, lines.length + 5);
  const title = `cc-outline ${VERSION}`;
  const hint = "i / esc close";

  return (
    <Dialog layout={layout} width={width} height={height}>
      <Text wrap="truncate">
        <Text bold>{title}</Text>
        {" ".repeat(Math.max(1, inner - stringWidth(title) - stringWidth(hint)))}
        <Text dimColor>{hint}</Text>
      </Text>
      <Text dimColor wrap="truncate">
        by {AUTHOR} · {LICENSE} License
      </Text>
      <Text> </Text>
      {lines}
    </Dialog>
  );
}
