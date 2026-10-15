import { homedir } from "node:os";
import { basename } from "node:path";
import { Text } from "ink";
import stringWidth from "string-width";
import { detectTerminal } from "../open.js";
import { settingsFile } from "../settings.js";
import { AUTHOR, LICENSE, VERSION } from "../version.js";
import { paneSwitchKey } from "./focus.js";
import { Dialog, type Layout, type Mode } from "./layout.js";
import { L } from "../i18n/index.js";

interface Props {
  layout: Layout;
  mode: Mode;
  cwd: string;
  /** Transcript of the shown session. */
  path?: string;
  /** Git repository root; null outside a repository, undefined while unknown. */
  gitRoot?: string | null;
  /** A viewer of one session (an observer, a remote viewer): no other views, and it does not move or restart. */
  oneSession?: boolean;
}

/** Keys of each view, shown in two columns: the list's keys, the view's own, then those all views share. */
function keysOf(mode: Mode): [string, string][] {
  const t = L().info;
  const common = mode === "settings" ? t.common.filter(([k]) => k !== "r") : t.common;
  return [...t.list(t.entry[mode]), ...t.views[mode], ...common];
}

/** The keys a viewer of one session does not have. */
const VIEWER_KEYS = new Set(["1 – 6", "Tab → ⇧Tab ←", "p", "r"]);

const MAX_WIDTH = 78;
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
  return terminal === "tmux" ? "tmux" : terminal === "wt" ? "Windows Terminal" : L().info.other;
}

/**
 * Modal box centred over the view: version, what is being shown, where the
 * data comes from, and the keys of the current view.
 */
export function InfoDialog({ layout, mode, cwd, path, gitRoot, oneSession = false }: Props) {
  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Border (2) and padding (2).
  const inner = width - 4;
  const t = L().info;
  // As wide as the longest label of the language, a space after it.
  const LABEL_WIDTH = Math.max(11, ...[t.project, t.session, t.transcript, t.gitRepo, t.terminal, t.settings].map((l) => stringWidth(l) + 1));
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

  const keys = oneSession ? keysOf(mode).filter(([k]) => !VIEWER_KEYS.has(k)) : keysOf(mode);
  const half = Math.ceil(keys.length / 2);
  const columnWidth = Math.floor(inner / 2);
  const keyCell = (entry?: [string, string]) =>
    entry ? (
      <>
        <Text color="yellow">{entry[0].padEnd(KEY_WIDTH)}</Text>
        <Text>{entry[1].slice(0, columnWidth - KEY_WIDTH - 1).padEnd(columnWidth - KEY_WIDTH)}</Text>
      </>
    ) : null;

  const lines = [
    heading(t.session),
    row(t.project, tilde(cwd)),
    row(t.session, path ? basename(path, ".jsonl") : t.noneFound),
    row(t.transcript, path ? tilde(path) : "–"),
    row(t.gitRepo, gitRoot === undefined ? "…" : gitRoot === null ? t.noRepo : tilde(gitRoot)),
    <Text key="gap1"> </Text>,
    heading(t.viewer),
    row(t.terminal, `${terminalName()} · ${paneSwitchKey("left")} / ${paneSwitchKey("right")} ${t.switchPanes}`),
    row(t.settings, tilde(settingsFile())),
    <Text key="gap2"> </Text>,
    heading(t.keys(L().tabs[mode])),
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
  const hint = t.close;

  return (
    <Dialog layout={layout} width={width} height={height}>
      <Text wrap="truncate">
        <Text bold>{title}</Text>
        {" ".repeat(Math.max(1, inner - stringWidth(title) - stringWidth(hint)))}
        <Text dimColor>{hint}</Text>
      </Text>
      <Text dimColor wrap="truncate">
        {t.by(AUTHOR, LICENSE)}
      </Text>
      <Text> </Text>
      {lines}
    </Dialog>
  );
}
