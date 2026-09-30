import { Text, useInput } from "ink";
import { homedir } from "node:os";
import { useEffect, useMemo, useState } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { AUTO_OPEN_VALUES, DEFAULT_SETTINGS, FILTER_IN_VALUES, PLACEMENT_VALUES, RANGE_NAMES, RANGE_VALUES, VIEW_SETTINGS, reloadSettings, settingsFile, updateSettings, type Settings } from "../settings.js";
import { projectData } from "../projectData.js";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog.js";
import { doubleClicks } from "./openKey.js";
import { useFocused } from "./focus.js";
import { haystack } from "../filter.js";
import { bold, dim, EntryText, handleNavigation, List, markFooter, markKeys, previewHeader, rule, Screen, Star, type Layout } from "./layout.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
import { useFavorites } from "./useFavorites.js";
import { isReloadKey, useOnReload } from "./reload.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { useSettings } from "./useSetting.js";
import { renderMarkdown } from "../render/markdown.js";
import { compareVersions, remainingCommands, UPDATE_STEPS, type Release } from "../update.js";
import { VERSION } from "../version.js";
import { useClipboard } from "./useClipboard.js";
import { useUpdateInfo, type Update } from "./useUpdate.js";

interface Props {
  layout: Layout;
  /** The view takes keys. */
  active: boolean;
  /** Reports whether a confirmation is open; the app then leaves all keys to it. */
  onModal?: (open: boolean) => void;
  /** The filter dialog opened or closed. */
  onTyping?: (typing: boolean) => void;
  cwd: string;
  /** Deletes the project's saved data and reloads the views (App). */
  onResetData?: () => void;
  /** An entry to select, asked for from outside (`releases`: /cco:releases; `update`: a click on the top bar). */
  select?: { key: string; at: number };
}

/** The entries of the Reset group below the settings: actions, run with Enter after a confirmation. */
interface ResetAction {
  id: "settings" | "data";
  label: string;
  description: string;
}

export const RESET_ACTIONS: ResetAction[] = [
  {
    id: "settings",
    label: "all settings to default",
    description: "Sets every setting above back to its default and removes the marks ★ of the settings. R does the same from any setting; r resets only the selected one.",
  },
  {
    id: "data",
    label: "saved data of this project",
    description:
      "Deletes what cco remembers for this project: the marks ★ of turns, files, plans, sessions and days, the selected entry and scroll position of every list, the view and placement of each session, and whether the viewer was open when Claude Code last exited. The settings stay, and nothing of Claude Code is touched: transcripts, sessions and git are as before. The views reload empty.",
  },
];

interface Row {
  key: keyof Settings;
  /** Area the setting belongs to, the list's separator above it. */
  group: string;
  label: string;
  description: string;
  /** The values in the order Enter steps through them, each with what it does. */
  values: [value: string | boolean, meaning: string][];
  /** The key that switches it in its own view, e.g. "t in Chat". */
  viewKey?: string;
  notes?: string[];
}

const ON_OFF = (on: string, off: string): Row["values"] => [
  [true, on],
  [false, off],
];

const AUTO_OPEN_MEANINGS: Record<(typeof AUTO_OPEN_VALUES)[number], string> = {
  remember: "reopen it if it was open when Claude Code last exited in the project",
  always: "open it on every start, in every project; the chat unless another view was open last",
  never: "never open it by itself; /cco:… commands still do",
};

export const PLACEMENT_MEANINGS: Record<(typeof PLACEMENT_VALUES)[number], string> = {
  right: "a pane right of Claude Code",
  left: "a pane left of Claude Code",
  window: "a window of its own (in tmux: a tmux window)",
};

const FILTER_IN_MEANINGS: Record<(typeof FILTER_IN_VALUES)[number], string> = {
  list: "what the rows show",
  details: "what the previews add",
  both: "rows and details",
};

/** The first row of a view's group: whether the view has a tab. */
function viewTab(key: keyof Settings, name: string, number: string, what: string): Row {
  return {
    key,
    group: name,
    label: "tab",
    description: `Whether the ${name} view (${what}) has a tab. Hidden, it keeps its number: ${number} does nothing, and the other views keep theirs. A /cco:… command or --view that names it still opens it, and its tab shows while it is open. Settings (6) cannot be hidden, and at least one other view stays shown.`,
    values: ON_OFF("show its tab", "hide it"),
  };
}

/** The last row of a view's group: which end of its list is at the top. */
function listOrder(key: keyof Settings, view: string, what: string): Row {
  return {
    key,
    group: view,
    label: "order",
    description: `Whether the ${view} list shows the newest or the oldest ${what} at the top. The keys follow what you see: ↑/↓ go up and down the list, Home and g to the top, End and G to the bottom.`,
    values: [
      ["oldest-first", "oldest at the top, newest at the bottom"],
      ["newest-first", "newest at the top, oldest at the bottom"],
    ],
    viewKey: `s in ${view}`,
  };
}


/** A view's row for how far back its list reaches at first. */
function listRange(key: keyof Settings, view: string, what: string, dated: string): Row {
  return {
    key,
    group: view,
    label: "range",
    description: `How far back the ${view} list reaches when it is read: the ${what} ${dated} today or in the days before it, counted in calendar days from midnight. The list shows the newest at the top and ends with "↓ more ↓", which reads the whole history until the viewer restarts. Transcripts last written before the range are not read, so a short range reads faster.`,
    values: RANGE_VALUES.map((v): [string, string] => [v, v === "all" ? "the whole history, without ↓ more ↓" : v === "today" ? "only today" : `today and the ${Number.parseInt(v, 10) - 1} days before`]),
  };
}

/** Every setting the view offers, by group; the list and the details come from here. */
export const SETTING_ROWS: Row[] = [
  {
    key: "autoOpen",
    group: "Start",
    label: "auto open",
    description: "Whether the viewer opens by itself when Claude Code starts (also with --resume and --continue). The focus stays in Claude Code, and no second viewer opens while one runs in the project.",
    values: AUTO_OPEN_VALUES.map((v) => [v, AUTO_OPEN_MEANINGS[v]]),
    notes: ["Needs the plugin's hooks, and Windows Terminal or tmux.", "Takes effect at the next start of Claude Code."],
  },
  {
    key: "placement",
    group: "Start",
    label: "placement",
    description: "Where the viewer opens, when Claude Code starts and with /cco:… commands. p in the viewer moves it to another place and remembers that place for the session; this setting is for sessions without one.",
    values: PLACEMENT_VALUES.map((v) => [v, PLACEMENT_MEANINGS[v]]),
    notes: [
      "A window takes the focus from Claude Code: Windows Terminal cannot hand it back to another window.",
      "Takes effect the next time the viewer opens; a running viewer stays where it is.",
    ],
  },
  {
    key: "confirmQuit",
    group: "General",
    label: "confirm quit",
    description: "Whether q and Esc ask before the viewer closes. The viewer still closes by itself when the session ends.",
    values: ON_OFF("ask first (Enter yes, Esc no)", "close right away"),
  },
  {
    key: "marquee",
    group: "General",
    label: "marquee",
    description: "Whether the selected list entry scrolls sideways when it is too long for the list, at most 250 columns, then from the start.",
    values: ON_OFF("scroll long entries", "cut them off with …"),
  },
  {
    key: "dateSeparators",
    group: "General",
    label: "date separators",
    description:
      "Whether Chat, Plan, Sessions and the trash show a line with the date (── Mon 28 Sep 2026 ──) above each day's entries, unless all of them are from today; the entries then show only their time. The Monitor's days get a line per year (── 2025 ──) once they reach into another year. Off, Sessions and the trash show the date in each row again.",
    values: ON_OFF("a line per day", "no lines"),
  },
  {
    key: "pinnedGroup",
    group: "General",
    label: "pinned group",
    description:
      "Whether every list (Chat, Changes, Plan, Sessions, Monitor and Settings) shows its marked entries (Space) at the top, under ── ★ Pinned ── and above ── Pinned end ──, in the order of the list. They then show only there, not in their place below; ↑↓, Home/End and Shift+↑/↓ follow the rows on screen. A filter applies to them too. Sessions and the Monitor pin only what their range has read.",
    values: ON_OFF("marked entries at the top", "marked entries in their place"),
  },
  {
    key: "rememberPositions",
    group: "General",
    label: "remember positions",
    description: "Whether every list keeps its selected entry and the scroll position of each entry across restarts of the viewer. Switching entries keeps positions either way while the viewer runs.",
    values: ON_OFF("store them per project", "start fresh after each restart"),
    notes: ["Stored in ~/.claude/cco/<project>.positions.json; switching off keeps the file.", "Takes effect when the viewer starts."],
  },
  {
    key: "rememberView",
    group: "General",
    label: "view per session",
    description: "Whether each session comes back in the view it was shown in last (Chat, Changes, Plan, Sessions or Settings): when Claude Code starts or resumes it, when you start the viewer without --view, and when the viewer follows it after /resume. A /cco:… command still opens the view it names.",
    values: ON_OFF("reopen the session's last view", "start in the chat, or the view shown last in the project"),
    notes: ["Stored per project in ~/.claude/cco/<project>.views.json."],
  },
  {
    key: "mouse",
    group: "General",
    label: "mouse",
    description: "Whether the viewer takes the mouse: a click on a web address opens it in the browser, a click in a list selects the entry, a double click does what Enter does, and the wheel scrolls the preview (or moves through the list). While it is on, the terminal leaves clicks to the viewer: select text with Shift+drag in Windows Terminal (in tmux, with Shift or your terminal's modifier).",
    values: ON_OFF("clicks and wheel go to the viewer", "the terminal keeps the mouse (Ctrl+click opens links)"),
  },
  {
    key: "filterIn",
    group: "General",
    label: "filter in",
    description:
      "What the list filter (Ctrl+F) looks at. The list: what an entry's row shows (prompt, file path, plan or session title, day, setting name). The details: what its preview adds (attached files and subagents, the plan text and feedback, a session's prompts, files and branch, the models of a day, a setting's description). In the filter dialog, ^L and ^D switch them on and off, which changes this setting.",
    values: FILTER_IN_VALUES.map((v) => [v, FILTER_IN_MEANINGS[v]]),
  },
  {
    key: "updateCheck",
    group: "General",
    label: "update check",
    description:
      "Whether the viewer asks npm for the latest version of cco and GitHub for the release notes when it starts. A newer version shows in the top bar, and the Releases entries below the settings show the notes of each version and run the update.",
    values: ON_OFF("ask npm and GitHub when the viewer starts", "no network requests"),
    notes: ["F5 in Settings checks once either way.", "The answer is kept in ~/.claude/cco/releases.json, so the notes also show offline."],
  },
  viewTab("viewChat", "Chat", "1", "the session's turns, rendered as Markdown"),
  {
    key: "showTools",
    group: "Chat",
    label: "tool calls",
    description: "How much the chat shows of Claude's tool calls (reads, edits, commands, searches) between the text. With it off, Claude's questions and your answers (AskUserQuestion) still show, in a yellow frame; otherwise they are a tool call like the others.",
    values: [
      ["off", "hide them"],
      ["compact", "a line each, with the result: lines read, +/− of an edit, ✓ or ✗ of a command"],
      ["full", "also the command, the last 10 lines of its output, and found files"],
    ],
    viewKey: "t in Chat",
  },
  {
    key: "showThinking",
    group: "Chat",
    label: "thinking",
    description: "Whether the chat shows Claude's thinking blocks.",
    values: ON_OFF("show them", "hide them"),
    viewKey: "h in Chat",
  },
  {
    key: "showAgents",
    group: "Chat",
    label: "agents",
    description: "Whether the chat shows the subagents Claude started, where it started them: type, task, model, and whether they are running, finished or failed, with their duration, tool uses and tokens. a in Chat opens what a subagent did.",
    values: ON_OFF("show them", "hide them"),
  },
  {
    key: "chatWrap",
    group: "Chat",
    label: "wrap",
    description: "Whether long lines in the chat wrap; off, they are cut and ctrl+←/→ scrolls sideways.",
    values: ON_OFF("wrap", "scroll sideways"),
    viewKey: "w in Chat",
  },
  listOrder("chatOrder", "Chat", "turns"),
  viewTab("viewGit", "Changes", "2", "the changed files with their diffs"),
  {
    key: "wrap",
    group: "Changes",
    label: "wrap",
    description: "Whether long lines in diffs wrap; off, they are cut and ctrl+←/→ scrolls sideways.",
    values: ON_OFF("wrap", "scroll sideways"),
    viewKey: "w in Changes",
  },
  viewTab("viewPlan", "Plan", "3", "the plans Claude presented in plan mode"),
  {
    key: "planWrap",
    group: "Plan",
    label: "wrap",
    description: "Whether long lines of plans wrap; off, they are cut and ctrl+←/→ scrolls sideways.",
    values: ON_OFF("wrap", "scroll sideways"),
    viewKey: "w in Plan",
  },
  listOrder("planOrder", "Plan", "plans"),
  viewTab("viewSessions", "Sessions", "4", "the overview of past sessions"),
  {
    key: "allProjects",
    group: "Sessions",
    label: "all projects",
    description: "Whether the Sessions view lists the sessions of all projects or only of this one. The trash follows the same choice.",
    values: ON_OFF("all projects", "this project"),
    viewKey: "a in Sessions",
  },
  listRange("sessionsRange", "Sessions", "sessions", "started"),
  viewTab("viewMonitor", "Monitor", "5", "response speed, wait and errors over the day"),
  {
    ...listRange("monitorRange", "Monitor", "days", "with responses"),
    notes: ["The usual values (the median of the 30 days before a day) come from the days read, so a short range has fewer of them."],
  },
];

const valueName = (v: string | boolean) => (typeof v === "boolean" ? (v ? "on" : "off") : v in RANGE_NAMES ? RANGE_NAMES[v as keyof typeof RANGE_NAMES] : v);

/** A value as the list shows it: the order values without "-first", so the labels keep their room. */
export const shortValueName = (v: string | boolean) => (v === "newest-first" ? "newest" : v === "oldest-first" ? "oldest" : valueName(v));

/** The value after `current` in the row's order, wrapping around. */
/** Whether `key` is the setting of the only view besides Settings that is still shown. */
export function isLastView(settings: Settings, key: keyof Settings): boolean {
  const shown = Object.values(VIEW_SETTINGS).filter((k) => settings[k] === true);
  return shown.length === 1 && shown[0] === key;
}

export function nextValue(row: Row, current: string | boolean): string | boolean {
  const i = row.values.findIndex(([v]) => v === current);
  return row.values[(i + 1) % row.values.length][0];
}

function tilde(path: string): string {
  const home = homedir();
  return path.toLowerCase().startsWith(home.toLowerCase()) ? "~" + path.slice(home.length) : path;
}

/** Detail lines of a setting: its values (current one marked, default named), the view key and notes. */
/** The preview of a reset action: what it does, and what it would change or delete right now. */
function resetLines(action: ResetAction, changed: string[], marked: number, saved: { name: string; path: string }[], width: number): string[] {
  const wrap = (text: string, indent = "") =>
    wrapAnsi(text, Math.max(10, width - indent.length), { hard: true })
      .split("\n")
      .map((l) => indent + l);
  const lines = [...wrap(action.description), ""];
  if (action.id === "settings") {
    lines.push(bold("Changed"));
    if (changed.length === 0) lines.push(dim("  none: every setting is at its default"));
    for (const name of changed) lines.push(...wrap(name, "  "));
    if (marked > 0) lines.push("", bold("Marked"), `  ${marked} ★`);
  } else {
    lines.push(bold("Saved"));
    if (saved.length === 0) lines.push(dim("  nothing saved for this project"));
    for (const d of saved) lines.push(...wrap(d.name, "  "), ...wrap(dim(tilde(d.path)), "    "));
  }
  lines.push("", dim("Enter asks before anything is changed."));
  return lines;
}

function settingLines(row: Row, current: string | boolean, width: number): string[] {
  const wrap = (text: string, indent = "") =>
    wrapAnsi(text, Math.max(10, width - indent.length), { hard: true })
      .split("\n")
      .map((l) => indent + l);
  const lines = [...wrap(row.description), ""];
  lines.push(bold("Values"));
  for (const [value, meaning] of row.values) {
    const selected = value === current;
    const name = valueName(value) + (value === DEFAULT_SETTINGS[row.key] ? " (default)" : "");
    const [first, ...rest] = wrap(`${name}: ${meaning}`, "  ");
    lines.push((selected ? "\u001b[32m● " : dim("○ ")) + first.slice(2) + (selected ? "\u001b[39m" : ""), ...rest);
  }
  if (row.viewKey) lines.push("", dim(`Also ${row.viewKey}.`));
  for (const note of row.notes ?? []) lines.push("", ...wrap(dim(note)));
  return lines;
}

/** The entries of the Releases group: the update on offer, then each release, or a note while there are none. */
type ReleaseEntry = { kind: "update" } | { kind: "release"; release: Release } | { kind: "releases" };
type Entry = Row | ReleaseEntry | ResetAction;

/** The group an entry is listed under. */
const groupOf = (e: Entry): string => ("key" in e ? e.group : "id" in e ? "Reset" : "Releases");

const keyOf = (e: Entry): string =>
  "key" in e ? e.key : "id" in e ? `reset:${e.id}` : e.kind === "release" ? `release:${e.release.tag}` : e.kind;

function releaseEntries(update: Update): ReleaseEntry[] {
  const offer: ReleaseEntry[] = update.state.kind !== "none" || update.run ? [{ kind: "update" }] : [];
  if (update.releases.length === 0) return [...offer, { kind: "releases" }];
  return [...offer, ...update.releases.map((release) => ({ kind: "release" as const, release }))];
}

/** The entry `key` asks for: `releases` is the update if there is one, else the installed release. */
function resolveKey(key: string | undefined, entries: Entry[]): number {
  const at = (k: string) => entries.findIndex((e) => keyOf(e) === k);
  const installed = entries.findIndex((e) => "kind" in e && e.kind === "release" && e.release.version === VERSION);
  const firstRelease = entries.findIndex((e) => "kind" in e);
  if (key === "releases") return [at("update"), installed, firstRelease].find((i) => i >= 0) ?? 0;
  // The update entry is gone once it ran: the viewer reopens on the version it installed.
  if (key === "update" && at(key) < 0) return [installed, firstRelease].find((i) => i >= 0) ?? 0;
  return key ? Math.max(0, at(key)) : 0;
}

const GREEN = (s: string) => `\u001b[32m${s}\u001b[39m`;
const RED = (s: string) => `\u001b[31m${s}\u001b[39m`;
const YELLOW = (s: string) => `\u001b[33m${s}\u001b[39m`;

/** The last `n` lines a command wrote, without colours and with progress lines (\r) reduced to their last state. */
function outputTail(text: string, n: number): string[] {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((l) => l.split("\r").at(-1) ?? "")
    .filter((l) => l.trim() !== "")
    .slice(-n);
}

const newerReleases = (update: Update) => update.releases.filter((r) => compareVersions(r.version, VERSION) > 0);
const day = (iso?: string) => (iso ? iso.slice(0, 10) : undefined);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The update entry's details: what Enter does, the steps while they run, then the notes of the newer releases. */
function updateLines(update: Update, width: number): string[] {
  const wrap = (text: string, indent = "") =>
    wrapAnsi(text, Math.max(10, width - indent.length), { hard: true })
      .split("\n")
      .map((l) => indent + l);
  const { state, run } = update;
  const commands = UPDATE_STEPS.map((s) => `  ${s.command}`);
  const lines: string[] = [];
  if (run) {
    for (const s of run.steps) {
      const mark = s.status === "done" ? GREEN("✓") : s.status === "failed" ? RED("✗") : s.status === "running" ? YELLOW("●") : dim("○");
      lines.push(...wrap(`${mark} ${s.step.label}: ${s.step.command}`));
      if (s.status === "running" || s.status === "failed") for (const l of outputTail(s.output, 12)) lines.push(...wrap(dim(l), "    "));
    }
    lines.push("");
    if (run.status === "failed")
      lines.push(...wrap("The update stopped. Run the rest by hand (c copies it), then close the viewer with q and open it again:"), ...remainingCommands(run.steps).map((c) => `  ${c}`));
    else if (run.status === "done")
      lines.push(...wrap(`Updated to v${run.target}. The viewer opens again with it; if it does not, close it with q and open it again. Restart Claude Code for the plugin.`));
    else lines.push(dim("Updating…"));
  } else if (state.kind === "update") {
    lines.push(
      ...wrap(`v${state.target} is out; this is v${VERSION}. Enter asks, then runs:`),
      ...commands,
      "",
      ...wrap(dim("Then the viewer opens again with the new version. The plugin (hooks, /cco:… commands) takes effect when Claude Code restarts.")),
    );
  } else if (state.kind === "restart") {
    lines.push(...wrap(`v${state.target} is installed; this viewer still runs v${VERSION}. Enter opens it again with the new version.`));
  } else if (state.kind === "dev") {
    lines.push(
      ...wrap(`v${state.target} is out; this is v${VERSION}, run from ${tilde(update.root)} (npm link or npx), which cco does not update. Update the checkout, or install the release (c copies it):`),
      ...commands,
    );
  }
  for (const r of newerReleases(update)) lines.push("", rule(width, `v${r.version}`), "", ...releaseLines(r, width));
  return lines;
}

function releaseLines(release: Release, width: number): string[] {
  return release.body.trim() ? renderMarkdown(release.body, width) : [dim("No notes for this release.")];
}

/** The details while no release notes are known. */
function releasesNote(update: Update, width: number): string[] {
  const text = update.checking
    ? "Asking npm and GitHub…"
    : !update.enabled && update.checkedAt === undefined
      ? "The update check is off (General: update check), so cco has not asked GitHub for the release notes. F5 checks once."
      : "npm and GitHub could not be reached. F5 tries again.";
  return wrapAnsi(text, Math.max(10, width), { hard: true }).split("\n");
}

/** The list: the settings, the releases, then the reset actions. */
export function settingsEntries(update: Update): Entry[] {
  return [...SETTING_ROWS, ...releaseEntries(update), ...RESET_ACTIONS];
}

export function SettingsView({ layout, active, onModal, onTyping, cwd, onResetData, select: asked }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const [isDoubleClick] = useState(() => doubleClicks());
  const settings = useSettings();
  const update = useUpdateInfo();
  const copy = useClipboard();
  const [copied, setCopied] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const positions = usePositions(cwd, "settings");
  const listEntries = settingsEntries(update);
  const entries = listEntries.map(keyOf);
  // Kept by key: the releases arrive after the start and move the entries below them.
  const [selectedKey, setSelectedKey] = useState(() => positions.selected);
  const index = entries.includes(selectedKey ?? "") ? entries.indexOf(selectedKey!) : resolveKey(selectedKey, listEntries);
  const entry = listEntries[index];
  const row = "key" in entry ? entry : undefined;
  const reset = "id" in entry ? entry : undefined;
  const release = "kind" in entry ? entry : undefined;
  const current = row ? settings[row.key] : undefined;
  const entryKey = entries[index];
  const favorites = useFavorites(cwd, "settings");
  // F5: settings.json is read again, so changes by other viewers show in every view, and npm and GitHub are asked again.
  useOnReload(({ done }) => {
    reloadSettings();
    void update.recheck().then(done);
  });
  const marked = entries.filter((e) => favorites.isMarked(e)).length;
  // A setting is found by its value, group and name as listed; its details are what it does.
  const filter = useListFilter({
    items: listEntries,
    text: (e) =>
      "key" in e
        ? { list: haystack([valueName(settings[e.key]), e.group, e.label]), details: e.description }
        : "id" in e
          ? { list: haystack(["Reset", e.label]), details: e.description }
          : e.kind === "release"
            ? { list: haystack(["Releases", e.release.tag, e.release.title]), details: e.release.body }
            : { list: haystack(["Releases", entryLabel(e)]), details: "" },
    deps: [settings, update.releases, update.state],
    selected: index,
    select: (i) => select(i),
    layout,
    onTyping,
    marked: (e) => favorites.isMarked(keyOf(e)),
  });

  const updating = update.run?.status === "running";
  // While the update runs, the app keeps q, p and the other views away from it.
  useEffect(() => onModal?.(confirmation !== undefined || updating), [confirmation, updating]);
  useEffect(() => positions.select(entryKey), [entryKey]);
  useEffect(() => {
    if (asked) setSelectedKey(entries[resolveKey(asked.key, listEntries)]);
  }, [asked?.at]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const changed = SETTING_ROWS.filter((r) => settings[r.key] !== DEFAULT_SETTINGS[r.key]);
  const canReset = changed.length > 0 || marked > 0;
  const saved = useMemo(() => (reset?.id === "data" ? projectData(cwd) : []), [reset?.id, cwd, confirmation]);
  const newer = newerReleases(update);
  const asOf = update.stale && update.checkedAt ? `as of ${day(new Date(update.checkedAt).toISOString())}` : undefined;

  function entryLabel(e: ReleaseEntry): string {
    if (e.kind === "release") return `v${e.release.version}${e.release.title !== e.release.tag ? ` ${e.release.title}` : ""}`;
    if (e.kind === "releases") return update.checking ? "checking…" : "release notes";
    const { state, run } = update;
    if (run) return `update to v${run.target}`;
    if (state.kind === "restart") return `restart with v${state.target}`;
    if (state.kind === "dev") return `v${state.target} is out`;
    return state.kind === "update" ? `update to v${state.target}` : "update";
  }

  function releaseHeader(e: ReleaseEntry): string[] {
    if (e.kind === "release") {
      const r = e.release;
      const cmp = compareVersions(r.version, VERSION);
      const details = [[day(r.date), cmp === 0 ? "installed" : cmp > 0 ? "new" : undefined, asOf].filter(Boolean).join(" · ")];
      return previewHeader(entryLabel(e), previewWidth, { marker: "◆ ", style: bold, details: r.url ? [...details, r.url] : details });
    }
    if (e.kind === "releases") return previewHeader("Releases", previewWidth, { marker: "◆ ", style: bold, details: [update.enabled ? "update check on" : "update check off"] });
    const detail = update.install === "dev" ? `development install · v${VERSION}` : `installed v${VERSION}`;
    const title = entryLabel(e);
    return previewHeader(title[0].toUpperCase() + title.slice(1), previewWidth, {
      marker: "↑ ",
      style: bold,
      details: [[detail, newer.length > 0 ? plural(newer.length, "newer release") : undefined, asOf].filter(Boolean).join(" · ")],
    });
  }

  const header = useMemo(
    () =>
      fitHeader(
        reset
          ? previewHeader(`Reset: ${reset.label}`, previewWidth, {
              marker: "↺ ",
              style: bold,
              details: [reset.id === "settings" ? `${changed.length} changed${marked > 0 ? ` · ${marked} marked` : ""}` : `${saved.length} of 4 files saved`],
            })
          : release
            ? releaseHeader(release)
            : previewHeader(`${row!.group}: ${row!.label}`, previewWidth, {
                marker: "⚙ ",
                style: bold,
                details: [`${valueName(current!)} · default ${valueName(DEFAULT_SETTINGS[row!.key])}`],
              }),
        bodyHeight,
      ),
    [entry, update, current, changed.length, marked, saved.length, previewWidth, bodyHeight],
  );
  const lines = useMemo(
    () =>
      reset
        ? resetLines(reset, changed.map((r) => `${r.group} ${r.label}`), marked, saved, previewWidth)
        : release
          ? release.kind === "update"
            ? updateLines(update, previewWidth)
            : release.kind === "release"
              ? releaseLines(release.release, previewWidth)
              : releasesNote(update, previewWidth)
          : settingLines(row!, current!, previewWidth),
    [entry, update, current, changed.length, marked, saved, previewWidth],
  );
  const viewport = bodyHeightBelow(header, bodyHeight);
  const scroll = positions.scroll(entryKey, lines.length, viewport);

  const set = (changes: Partial<Settings>) => updateSettings(changes);
  const select = (i: number) => setSelectedKey(entries[Math.max(0, Math.min(entries.length - 1, i))]);
  const askResetSettings = () =>
    setConfirmation({
      title: "Reset all settings?",
      lines: [
        ...(changed.length > 0
          ? [`${changed.length} of ${SETTING_ROWS.length} differ from the default:`, changed.map((r) => `${r.group} ${r.label}`).join(", ")]
          : ["Every setting is at its default."]),
        ...(marked > 0 ? [`The marks ★ of ${marked} ${marked === 1 ? "entry" : "entries"} are removed.`] : []),
      ],
      onConfirm: () => {
        set({ ...DEFAULT_SETTINGS });
        favorites.clear();
      },
    });
  const askResetData = () =>
    setConfirmation({
      title: "Delete the saved data of this project?",
      lines: [...saved.map((d) => `· ${d.name}`), "Settings, transcripts and git stay."],
      danger: true,
      onConfirm: () => onResetData?.(),
    });
  const { state } = update;
  const canUpdate = state.kind === "update" && !updating && update.run?.status !== "done";
  const askUpdate = () =>
    state.kind === "update" &&
    setConfirmation({
      title: `Update cco to v${state.target}?`,
      lines: [...UPDATE_STEPS.map((s) => s.command), "Then the viewer opens again with the new version."],
      onConfirm: update.start,
    });
  // What c copies on the update entry: the commands still to run.
  const commandsToCopy = update.run?.status === "failed" ? remainingCommands(update.run.steps) : UPDATE_STEPS.map((s) => s.command);
  const onUpdate = release?.kind === "update";

  /** Enter (or a double click) on the selected entry: a reset or the update asks first, a setting takes its next value. */
  const activate = () => {
    if (filter.none) return;
    if (reset) {
      if (reset.id === "settings") return canReset && askResetSettings();
      return saved.length > 0 && askResetData();
    }
    if (onUpdate) {
      if (state.kind === "restart") return update.restart();
      return canUpdate && askUpdate();
    }
    // The last view besides Settings stays: hiding it would leave only this one.
    if (row && !isLastView(settings, row.key)) set({ [row.key]: nextValue(row, current!) });
  };

  useInput(
    (input, key) => {
      // Ctrl+R reloads (App), which r must not take as "back to the default".
      if (isReloadKey(input, key) || filter.handleKey(input, key)) return;
      const mark = markKeys(input, key);
      if (mark === "toggle") {
        if (filter.none) return;
        if (favorites.isMarked(entryKey)) filter.unmarking(index);
        return favorites.toggle(entryKey);
      }
      if (mark) {
        const target = filter.nextMark(mark);
        return target !== undefined && select(target);
      }
      if (filter.none && (key.return || input === "r" || input === "c")) return;
      if (key.return && (reset || onUpdate || row)) return activate();
      if (onUpdate && input === "c") {
        void copy(commandsToCopy.join("\n")).then(() => setCopied(true));
        return;
      }
      if (input === "r" && row) return set({ [row.key]: DEFAULT_SETTINGS[row.key] });
      if (input === "R" && canReset) return askResetSettings();
      handleNavigation(input, key, { ...filter.nav, scroll, page: viewport - 2 });
    },
    { isActive: active && confirmation === undefined && !filter.open },
  );

  /** What a row shows: the label, and at its right end the value (or mark); the group is the separator above it. */
  const rowParts = (e: Entry): { value: string; color?: string; label: string } => {
    if ("key" in e) {
      const value = settings[e.key];
      return { value: shortValueName(value), color: value === DEFAULT_SETTINGS[e.key] ? undefined : "yellow", label: e.label };
    }
    if ("id" in e) return { value: "↺", label: e.label };
    if (e.kind === "release") {
      const cmp = compareVersions(e.release.version, VERSION);
      return { value: cmp === 0 ? "installed" : cmp > 0 ? "new" : "", color: cmp === 0 ? "green" : "yellow", label: entryLabel(e) };
    }
    if (e.kind === "update") return { value: state.kind === "restart" ? "↻" : "↑", color: "yellow", label: entryLabel(e) };
    return { value: "", label: entryLabel(e) };
  };

  const entryFooter = reset
    ? [{ text: "↵ reset", priority: 4 }]
    : onUpdate
      ? [
          ...(canUpdate ? [{ text: "↵ update", priority: 4 }] : state.kind === "restart" ? [{ text: "↵ restart", priority: 4 }] : []),
          { text: "c copy commands", priority: 3 },
        ]
      : release
        ? [{ text: "F5 check", priority: 2 }]
        : [
            { text: "↵ change", priority: 4 },
            { text: "r default", priority: 3 },
          ];
  return (
    <>
      <Screen
        layout={layout}
        mode="settings"
        status={
          <Text dimColor={!focused}>
            {/* The filter's count first: the path can be long. */}
            {filter.shown && `${filter.count(listEntries.length)} entries · `}
            {copied && <Text color="green">copied · </Text>}
            {tilde(settingsFile())}
            {changed.length > 0 && <Text color="yellow">{` · ${changed.length} changed`}</Text>}
            {update.checking && ` · checking for updates…`}
          </Text>
        }
        list={
          <List
            onPick={select}
            // A double click does what Enter does.
            onClick={(i) => isDoubleClick(i) && i === index && !updating && activate()}
            items={listEntries}
            shown={filter.shown}
            pinned={filter.pinned}
            filter={filter.banner}
            selected={index}
            height={bodyHeight}
            empty={filter.empty ?? "No settings"}
            itemKey={keyOf}
            group={groupOf}
            render={(e, isSelected) => {
              const star = favorites.isMarked(keyOf(e));
              const { value, color, label } = rowParts(e);
              // The value keeps its place at the right end; a label too long for the rest is cut (or scrolls).
              const labelWidth = Math.max(4, listWidth - (star ? 2 : 0) - (value ? stringWidth(value) + 1 : 0));
              const pad = Math.max(0, labelWidth - stringWidth(label));
              return (
                <>
                  {star && <Star />}
                  <EntryText text={label} width={labelWidth} selected={isSelected} active={active && confirmation === undefined} />
                  {value && <Text color={color}>{" ".repeat(pad + 1) + value}</Text>}
                </>
              );
            }}
          />
        }
        preview={
          filter.none ? (
            <Text dimColor>No setting matches the filter</Text>
          ) : (
            <Preview
              header={header}
              lines={lines}
              scroll={scroll.scroll}
              width={previewWidth}
              height={bodyHeight}
              onWheel={(d) => scroll.by(d)}
            />
          )
        }
        footer={[
          { text: "↑↓ setting", priority: 4 },
          ...entryFooter,
          ...markFooter(favorites.isMarked(entryKey), marked),
          ...filter.footer,
          ...(canReset ? [{ text: "R reset all", priority: 2 }] : []),
          { text: "1-6/tab view", priority: 1 },
        ]}
      />
      {confirmation && (
        <ConfirmDialog layout={layout} confirmation={confirmation} onClose={() => setConfirmation(undefined)} />
      )}
      {filter.dialog}
    </>
  );
}
