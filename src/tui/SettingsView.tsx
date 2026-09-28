import { Text, useInput } from "ink";
import { homedir } from "node:os";
import { useEffect, useMemo, useState } from "react";
import wrapAnsi from "wrap-ansi";
import { AUTO_OPEN_VALUES, DEFAULT_SETTINGS, PLACEMENT_VALUES, VIEW_SETTINGS, settingsFile, updateSettings, type Settings } from "../settings.js";
import { projectData } from "../projectData.js";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog.js";
import { useFocused } from "./focus.js";
import { nextMarked } from "../favorites.js";
import { bold, dim, EntryText, handleNavigation, List, markFooter, markKeys, previewHeader, Screen, Star, type Layout } from "./layout.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
import { useFavorites } from "./useFavorites.js";
import { usePositions } from "./usePositions.js";
import { useSettings } from "./useSetting.js";

interface Props {
  layout: Layout;
  /** The view takes keys. */
  active: boolean;
  /** Reports whether a confirmation is open; the app then leaves all keys to it. */
  onModal?: (open: boolean) => void;
  cwd: string;
  /** Deletes the project's saved data and reloads the views (App). */
  onResetData?: () => void;
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
  /** Area the setting belongs to, shown before the label. */
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

/** Every setting the view offers; the list and the details come from here. */
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
    description: "Whether the viewer takes the mouse: a click on a web address opens it in the browser, a click in a list selects the entry, and the wheel scrolls the preview (or moves through the list). While it is on, the terminal leaves clicks to the viewer: select text with Shift+drag in Windows Terminal (in tmux, with Shift or your terminal's modifier).",
    values: ON_OFF("clicks and wheel go to the viewer", "the terminal keeps the mouse (Ctrl+click opens links)"),
  },
  {
    key: "showTools",
    group: "Chat",
    label: "tool calls",
    description: "How much the chat shows of Claude's tool calls (reads, edits, commands, searches) between the text. Claude's questions and your answers (AskUserQuestion) always show.",
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
  {
    key: "wrap",
    group: "Changes",
    label: "wrap",
    description: "Whether long lines in diffs wrap; off, they are cut and ctrl+←/→ scrolls sideways.",
    values: ON_OFF("wrap", "scroll sideways"),
    viewKey: "w in Changes",
  },
  {
    key: "planWrap",
    group: "Plan",
    label: "wrap",
    description: "Whether long lines of plans wrap; off, they are cut and ctrl+←/→ scrolls sideways.",
    values: ON_OFF("wrap", "scroll sideways"),
    viewKey: "w in Plan",
  },
  {
    key: "allProjects",
    group: "Sessions",
    label: "all projects",
    description: "Whether the Sessions view lists the sessions of all projects or only of this one. The trash follows the same choice.",
    values: ON_OFF("all projects", "this project"),
    viewKey: "a in Sessions",
  },
  ...(
    [
      ["chatOrder", "Chat", "turns"],
      ["planOrder", "Plan", "plans"],
      ["sessionsOrder", "Sessions", "sessions (and the trash)"],
      ["monitorOrder", "Monitor", "days"],
    ] as const
  ).map(
    ([key, view, what]): Row => ({
      key,
      group: view,
      label: "order",
      description: `Whether the ${view} list shows the newest or the oldest ${what} at the top. The keys follow what you see: ↑/↓ go up and down the list, Home and g to the top, End and G to the bottom.`,
      values: [
        ["oldest-first", "oldest at the top, newest at the bottom"],
        ["newest-first", "newest at the top, oldest at the bottom"],
      ],
      viewKey: `s in ${view}`,
    }),
  ),
  ...(
    [
      ["viewChat", "Chat", "1", "the session's turns, rendered as Markdown"],
      ["viewGit", "Changes", "2", "the changed files with their diffs"],
      ["viewPlan", "Plan", "3", "the plans Claude presented in plan mode"],
      ["viewSessions", "Sessions", "4", "the overview of past sessions"],
      ["viewMonitor", "Monitor", "5", "response speed, wait and errors over the day"],
    ] as const
  ).map(
    ([key, name, number, what]): Row => ({
      key,
      group: "Views",
      label: name,
      description: `Whether the ${name} view (${what}) has a tab. Hidden, it keeps its number: ${number} does nothing, and the other views keep theirs. A /cco:… command or --view that names it still opens it, and its tab shows while it is open. Settings (6) cannot be hidden, and at least one other view stays shown.`,
      values: ON_OFF("show its tab", "hide it"),
    }),
  ),
];

const valueName = (v: string | boolean) => (typeof v === "boolean" ? (v ? "on" : "off") : v);

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

export function SettingsView({ layout, active, onModal, cwd, onResetData }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const settings = useSettings();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const positions = usePositions(cwd, "settings");
  const entries = [...SETTING_ROWS.map((r) => r.key as string), ...RESET_ACTIONS.map((a) => `reset:${a.id}`)];
  const [index, setIndex] = useState(() => Math.max(0, entries.indexOf(positions.selected ?? "")));
  // Below the settings come the reset actions.
  const reset = index >= SETTING_ROWS.length ? RESET_ACTIONS[index - SETTING_ROWS.length] : undefined;
  const row = SETTING_ROWS[Math.min(index, SETTING_ROWS.length - 1)];
  const current = settings[row.key];
  const entryKey = entries[index];
  const favorites = useFavorites(cwd, "settings");
  const marked = entries.filter((e) => favorites.isMarked(e)).length;

  useEffect(() => onModal?.(confirmation !== undefined), [confirmation]);
  useEffect(() => positions.select(entryKey), [entryKey]);

  const changed = SETTING_ROWS.filter((r) => settings[r.key] !== DEFAULT_SETTINGS[r.key]);
  const canReset = changed.length > 0 || marked > 0;
  const saved = useMemo(() => (reset?.id === "data" ? projectData(cwd) : []), [reset?.id, cwd, confirmation]);
  const header = useMemo(
    () =>
      fitHeader(
        reset
          ? previewHeader(`Reset: ${reset.label}`, previewWidth, {
              marker: "↺ ",
              style: bold,
              details: [reset.id === "settings" ? `${changed.length} changed${marked > 0 ? ` · ${marked} marked` : ""}` : `${saved.length} of 4 files saved`],
            })
          : previewHeader(`${row.group}: ${row.label}`, previewWidth, {
              marker: "⚙ ",
              style: bold,
              details: [`${valueName(current)} · default ${valueName(DEFAULT_SETTINGS[row.key])}`],
            }),
        bodyHeight,
      ),
    [reset, row, current, changed.length, marked, saved.length, previewWidth, bodyHeight],
  );
  const lines = useMemo(
    () =>
      reset
        ? resetLines(reset, changed.map((r) => `${r.group} ${r.label}`), marked, saved, previewWidth)
        : settingLines(row, current, previewWidth),
    [reset, row, current, changed.length, marked, saved, previewWidth],
  );
  const viewport = bodyHeightBelow(header, bodyHeight);
  const scroll = positions.scroll(entryKey, lines.length, viewport);

  const set = (changes: Partial<Settings>) => updateSettings(changes);
  const select = (i: number) => setIndex(Math.max(0, Math.min(entries.length - 1, i)));
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

  useInput(
    (input, key) => {
      const mark = markKeys(input, key);
      if (mark === "toggle") return favorites.toggle(entryKey);
      if (mark) {
        const target = nextMarked(entries, favorites.marks, index, mark);
        return target !== undefined && select(target);
      }
      if (reset && key.return) {
        if (reset.id === "settings") return canReset && askResetSettings();
        return saved.length > 0 && askResetData();
      }
      if (!reset && key.return) {
        // The last view besides Settings stays: hiding it would leave only this one.
        if (isLastView(settings, row.key)) return;
        return set({ [row.key]: nextValue(row, current) });
      }
      if (input === "r" && !reset) return set({ [row.key]: DEFAULT_SETTINGS[row.key] });
      if (input === "R" && canReset) return askResetSettings();
      handleNavigation(input, key, {
        select: (delta) => select(index + delta),
        first: () => select(0),
        last: () => select(entries.length - 1),
        scroll,
        page: viewport - 2,
      });
    },
    { isActive: active && confirmation === undefined },
  );

  const valueWidth = Math.max(...SETTING_ROWS.map((r) => valueName(settings[r.key]).length));
  return (
    <>
      <Screen
        layout={layout}
        mode="settings"
        status={
          <Text dimColor={!focused}>
            {tilde(settingsFile())}
            {changed.length > 0 && <Text color="yellow">{` · ${changed.length} changed`}</Text>}
          </Text>
        }
        list={
          <List
            onPick={select}
            items={[...SETTING_ROWS, ...RESET_ACTIONS]}
            selected={index}
            height={bodyHeight}
            empty="No settings"
            itemKey={(r) => ("key" in r ? r.key : `reset:${r.id}`)}
            render={(r, isSelected) => {
              const star = favorites.isMarked("key" in r ? r.key : `reset:${r.id}`);
              if (!("key" in r)) {
                return (
                  <>
                    <Text>{"↺".padEnd(valueWidth)} </Text>
                    <Text dimColor={!isSelected}>Reset </Text>
                    {star && <Star />}
                    <EntryText
                      text={r.label}
                      width={Math.max(4, listWidth - valueWidth - 8 - (star ? 2 : 0))}
                      selected={isSelected}
                      active={active && confirmation === undefined}
                    />
                  </>
                );
              }
              const value = settings[r.key];
              const isDefault = value === DEFAULT_SETTINGS[r.key];
              return (
                <>
                  <Text color={isDefault ? undefined : "yellow"}>{valueName(value).padEnd(valueWidth)} </Text>
                  <Text dimColor={!isSelected}>{r.group} </Text>
                  {star && <Star />}
                  <EntryText
                    text={r.label}
                    width={Math.max(4, listWidth - valueWidth - r.group.length - 2 - (star ? 2 : 0))}
                    selected={isSelected}
                    active={active && confirmation === undefined}
                  />
                </>
              );
            }}
          />
        }
        preview={
          <Preview
            header={header}
            lines={lines}
            scroll={scroll.scroll}
            width={previewWidth}
            height={bodyHeight}
            onWheel={(d) => scroll.by(d)}
          />
        }
        footer={[
          { text: "↑↓ setting", priority: 4 },
          { text: reset ? "↵ reset" : "↵ change", priority: 4 },
          ...(reset ? [] : [{ text: "r default", priority: 3 }]),
          ...markFooter(favorites.isMarked(entryKey), marked),
          ...(canReset ? [{ text: "R reset all", priority: 2 }] : []),
          { text: "1-6/tab view", priority: 1 },
        ]}
      />
      {confirmation && (
        <ConfirmDialog layout={layout} confirmation={confirmation} onClose={() => setConfirmation(undefined)} />
      )}
    </>
  );
}
