import { Text, useInput } from "ink";
import { homedir } from "node:os";
import { useEffect, useMemo, useState } from "react";
import wrapAnsi from "wrap-ansi";
import { AUTO_OPEN_VALUES, DEFAULT_SETTINGS, settingsFile, updateSettings, type Settings } from "../settings.js";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog.js";
import { useFocused } from "./focus.js";
import { bold, dim, EntryText, handleNavigation, List, previewHeader, Screen, type Layout } from "./layout.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
import { usePositions } from "./usePositions.js";
import { useSettings } from "./useSetting.js";

interface Props {
  layout: Layout;
  /** The view takes keys. */
  active: boolean;
  /** Reports whether a confirmation is open; the app then leaves all keys to it. */
  onModal?: (open: boolean) => void;
  cwd: string;
}

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
    key: "showTools",
    group: "Chat",
    label: "tool calls",
    description: "Whether the chat shows Claude's tool calls (reads, edits, commands) between the text.",
    values: ON_OFF("show them", "hide them"),
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
];

const valueName = (v: string | boolean) => (typeof v === "boolean" ? (v ? "on" : "off") : v);

/** The value after `current` in the row's order, wrapping around. */
export function nextValue(row: Row, current: string | boolean): string | boolean {
  const i = row.values.findIndex(([v]) => v === current);
  return row.values[(i + 1) % row.values.length][0];
}

function tilde(path: string): string {
  const home = homedir();
  return path.toLowerCase().startsWith(home.toLowerCase()) ? "~" + path.slice(home.length) : path;
}

/** Detail lines of a setting: its values (current one marked, default named), the view key and notes. */
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

export function SettingsView({ layout, active, onModal, cwd }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const settings = useSettings();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const positions = usePositions(cwd, "settings");
  const [index, setIndex] = useState(() => Math.max(0, SETTING_ROWS.findIndex((r) => r.key === positions.selected)));
  const row = SETTING_ROWS[index];
  const current = settings[row.key];

  useEffect(() => onModal?.(confirmation !== undefined), [confirmation]);
  useEffect(() => positions.select(row.key), [row.key]);

  const header = useMemo(
    () =>
      fitHeader(
        previewHeader(`${row.group}: ${row.label}`, previewWidth, {
          marker: "⚙ ",
          style: bold,
          details: [`${valueName(current)} · default ${valueName(DEFAULT_SETTINGS[row.key])}`],
        }),
        bodyHeight,
      ),
    [row, current, previewWidth, bodyHeight],
  );
  const lines = useMemo(() => settingLines(row, current, previewWidth), [row, current, previewWidth]);
  const viewport = bodyHeightBelow(header, bodyHeight);
  const scroll = positions.scroll(row.key, lines.length, viewport);

  const set = (changes: Partial<Settings>) => updateSettings(changes);
  const select = (i: number) => setIndex(Math.max(0, Math.min(SETTING_ROWS.length - 1, i)));
  const changed = SETTING_ROWS.filter((r) => settings[r.key] !== DEFAULT_SETTINGS[r.key]);

  useInput(
    (input, key) => {
      if (key.return || input === " ") return set({ [row.key]: nextValue(row, current) });
      if (input === "r") return set({ [row.key]: DEFAULT_SETTINGS[row.key] });
      if (input === "R" && changed.length > 0) {
        return setConfirmation({
          title: "Reset all settings?",
          lines: [`${changed.length} of ${SETTING_ROWS.length} differ from the default:`, changed.map((r) => `${r.group} ${r.label}`).join(", ")],
          onConfirm: () => set({ ...DEFAULT_SETTINGS }),
        });
      }
      handleNavigation(input, key, {
        select: (delta) => select(index + delta),
        first: () => select(0),
        last: () => select(SETTING_ROWS.length - 1),
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
            items={SETTING_ROWS}
            selected={index}
            height={bodyHeight}
            empty="No settings"
            itemKey={(r) => r.key}
            render={(r, isSelected) => {
              const value = settings[r.key];
              const isDefault = value === DEFAULT_SETTINGS[r.key];
              return (
                <>
                  <Text color={isDefault ? undefined : "yellow"}>{valueName(value).padEnd(valueWidth)} </Text>
                  <Text dimColor={!isSelected}>{r.group} </Text>
                  <EntryText
                    text={r.label}
                    width={Math.max(4, listWidth - valueWidth - r.group.length - 2)}
                    selected={isSelected}
                    active={active && confirmation === undefined}
                  />
                </>
              );
            }}
          />
        }
        preview={<Preview header={header} lines={lines} scroll={scroll.scroll} width={previewWidth} height={bodyHeight} />}
        footer={[
          { text: "←→ setting", priority: 4 },
          { text: "↵ change", priority: 4 },
          { text: "r default", priority: 3 },
          ...(changed.length > 0 ? [{ text: "R reset all", priority: 2 }] : []),
          { text: "1-5 view", priority: 1 },
        ]}
      />
      {confirmation && (
        <ConfirmDialog layout={layout} confirmation={confirmation} onClose={() => setConfirmation(undefined)} />
      )}
    </>
  );
}
