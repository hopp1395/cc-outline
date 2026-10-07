import { Text, useInput } from "ink";
import { homedir } from "node:os";
import { basename } from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { AUTO_OPEN_VALUES, DEFAULT_SETTINGS, FILTER_IN_VALUES, PLACEMENT_VALUES, RANGE_NAMES, RANGE_VALUES, UPDATE_VALUES, VIEW_SETTINGS, rangeStart, reloadSettings, settingsFile, updateSettings, type ColumnWidth, type ListRange, type Settings, type UpdateMode } from "../settings.js";
import { detectTerminal, type Terminal } from "../open.js";
import { positionsFile, sessionViewsFile } from "../transcript/locate.js";
import { dayLabel, dayOf } from "./days.js";
import { projectData } from "../projectData.js";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog.js";
import { currentStep, failureLines, outputTail, REOPEN_BY_HAND, stepText, useProgress, useProgressOpen, type Progress, type ProgressStep } from "./ProgressDialog.js";
import { doubleClicks } from "./openKey.js";
import { useFocused } from "./focus.js";
import { haystack } from "../filter.js";
import { bold, dim, EntryText, handleNavigation, List, LIST_WIDTHS, markFooter, markKeys, previewHeader, rule, Screen, Star, type Layout } from "./layout.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
import { useFavorites } from "./useFavorites.js";
import { isReloadKey, useOnReload } from "./reload.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { useSettings } from "./useSetting.js";
import { renderMarkdown } from "../render/markdown.js";
import { codeSpan } from "../render/terminal.js";
import { countFindings, countText, diagnoseGroup, DOCTOR_GROUPS, repairsOf, repairSteps, reportLines, runRepairs, type DoctorGroup, type Finding, type RepairResult } from "../doctor.js";
import { compareVersions, installedVersion, remainingCommands, UPDATE_STEPS, type Release } from "../update.js";
import { VERSION } from "../version.js";
import { useClipboard } from "./useClipboard.js";
import { useUpdateInfo, type Update, type UpdateRun } from "./useUpdate.js";
import { TIMING } from "../timing.js";

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
  /** Reopens the viewer where it is (Reset: restart), showing the restart's progress; none for a viewer started with --session, which does not move. */
  onRestart?: () => void;
  /** An entry to select, asked for from outside (`releases`: /cco:releases; `update`: a click on the top bar), with `ask` also the update's confirmation (setting update: auto). */
  select?: { key: string; at: number; ask?: boolean };
}

/** The entries of the Reset group below the settings: actions, run with Enter after a confirmation. */
interface ResetAction {
  id: "doctor" | "settings" | "data" | "restart";
  label: string;
  description: string;
}

export const RESET_ACTIONS: ResetAction[] = [
  {
    id: "restart",
    label: "restart the viewer",
    description:
      "Closes the viewer and opens it again in the same place and view, with the version of cco installed now: after an update by hand (`npm install -g`, a rebuild of a linked checkout) or when it misbehaves. The plugin's hooks and commands are loaded by Claude Code; they change only when Claude Code restarts. Asks first unless confirm quit is off.",
  },
  {
    id: "doctor",
    label: "doctor: check and repair",
    description:
      "Checks what cco needs: the installation (npm, the plugin and its version, the path the plugin starts cco by), cco's files in `~/.claude/cco` (of processes that have ended, unfinished writes, files that are no valid JSON, the trash), the settings, the terminal and whether the plugin's hooks run. `Enter` asks, then checks; nothing is changed by that. The report shows below, and `Enter` then offers to repair what it can; some findings name a command to run yourself. `cco doctor` in a shell does the same (`--fix` repairs), `/cco:doctor` shows the report in Claude Code.",
  },
  {
    id: "settings",
    label: "all settings to default",
    description: "Sets every setting above back to its default and removes the marks ★ of the settings. `R` does the same from any setting; `r` resets only the selected one.",
  },
  {
    id: "data",
    label: "saved data of this project",
    description:
      "Deletes what cco remembers for this project: the marks ★ of turns, files, plans, sessions and days, the selected entry and scroll position of every list, the view and placement of each session, and whether the viewer was open when Claude Code last exited. The settings stay, and nothing of Claude Code is touched: transcripts, sessions and git are as before. The views reload empty.",
  },
];

/** What a setting's texts can depend on: today for dates, the project for paths, the terminal for its keys and names. */
export interface TextContext {
  now: Date;
  cwd: string;
  terminal?: Terminal;
}

/** A text of the details, fixed or written for where it is shown (examples with today's dates, this project's files). */
type Text = string | ((c: TextContext) => string);

export const textOf = (text: Text, c: TextContext): string => (typeof text === "string" ? text : text(c));

/** A details text with what one types marked by backticks (`q`, `/cco:chat`, `~/.claude/cco`): those parts in the chat's inline-code style, without the backticks. */
export const codeMarks = (text: string) => text.replace(/`([^`]+)`/g, (_, code: string) => codeSpan(code));

/** A details text without its backticks, as the filter searches it. */
export const plainMarks = (text: string) => text.replaceAll("`", "");

/** Wraps a details text to `width`, its backticks turned into marks (not in a command's output: `marks` false), each line after `indent`. */
const wrapText = (text: string, width: number, indent = "", marks = true) =>
  wrapAnsi(marks ? codeMarks(text) : text, Math.max(10, width - indent.length), { hard: true })
    .split("\n")
    .map((l) => indent + l);

interface Row {
  key: keyof Settings;
  /** Area the setting belongs to, the list's separator above it. */
  group: string;
  label: string;
  description: Text;
  /** The values in the order Enter steps through them, each with what it does, with an example where one helps. */
  values: [value: string | boolean, meaning: Text][];
  /** The key that switches it in its own view, e.g. "t in Chat". */
  viewKey?: string;
  notes?: Text[];
}

const ON_OFF = (on: Text, off: Text): Row["values"] => [
  [true, on],
  [false, off],
];

/** "Thu 24 Sep" for the day `days` before today. */
const daysAgo = (days: number, now: Date) => dayLabel(dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime())!, "always");

/** "Thu 24 Sep" for the first day `range` covers. */
const firstDay = (range: ListRange, now: Date) => dayLabel(dayOf(rangeStart(range, now))!, "other", now.getTime());

const UPDATE_MEANINGS: Record<UpdateMode, Text> = {
  on: "ask npm and GitHub when the viewer starts; a newer version shows in the top bar (v0.7.0 → 0.8.0), and you update when you like",
  off: "no network requests; `F5` here still checks once",
  auto: "as on, and once the check finds a newer version, the viewer opens it here and asks whether to install it, once per start",
};

const AUTO_OPEN_MEANINGS: Record<(typeof AUTO_OPEN_VALUES)[number], Text> = {
  remember: "reopen it only if it was open when Claude Code last exited in the project: closed with `q` in one project, it stays closed there and still opens in the others",
  always: "open it on every start, in every project; in the chat, unless another view was open last (e.g. Changes, where you left it)",
  never: "never open it by itself; `/cco:chat`, `/cco:git` and the other `/cco:…` commands still do",
};

export const PLACEMENT_MEANINGS: Record<(typeof PLACEMENT_VALUES)[number], string> = {
  right: "a pane right of Claude Code",
  left: "a pane left of Claude Code",
  window: "a window of its own (in tmux: a tmux window)",
};

/** The placements as the details explain them: the pane's size, and how to get to a window in this terminal. */
const PLACEMENT_DETAILS: Record<(typeof PLACEMENT_VALUES)[number], Text> = {
  right: "a pane right of Claude Code; each takes half of the tab",
  left: "the same, left of Claude Code",
  window: (c) =>
    c.terminal === "wt"
      ? "a Windows Terminal window of its own, one per Claude Code; Claude Code keeps the whole tab, `Alt+Tab` switches"
      : c.terminal === "tmux"
        ? "a tmux window of its own next to Claude Code's; Claude Code keeps the whole window, your prefix and `n` or `p` (`Ctrl+b n`) switch"
        : PLACEMENT_MEANINGS.window,
};

const FILTER_IN_MEANINGS: Record<(typeof FILTER_IN_VALUES)[number], string> = {
  list: "what the rows show, e.g. a prompt, a file path or a session's title",
  details: "what the previews add, e.g. a session's changed files or a plan's text",
  both: "rows and details: finds the most, also entries that only mention the words somewhere",
};

/** How to select text while the viewer has the mouse, in this terminal. */
function selectText(terminal: Terminal | undefined): string {
  if (terminal === "wt") return "select text with `Shift+drag`";
  if (terminal === "tmux") return "select text with `Shift+drag`, or your terminal's modifier (`Option` in iTerm2)";
  return "select text with `Shift+drag` in Windows Terminal (in tmux, with `Shift` or your terminal's modifier)";
}

/** The first row of a view's group: whether the view has a tab. */
function viewTab(key: keyof Settings, name: string, number: string, what: string): Row {
  return {
    key,
    group: name,
    label: "tab",
    description: `Whether the ${name} view (${what}) has a tab. Hide a view you do not use, and the tab bar gets shorter. Hidden, it keeps its number: \`${number}\` does nothing, and the other views keep theirs (with Plan hidden, Sessions stays \`4\`). A \`/cco:…\` command or \`--view\` that names it still opens it, and its tab shows while it is open. Settings (\`6\`) cannot be hidden, and at least one other view stays shown.`,
    values: ON_OFF(`show its tab; \`${number}\` and \`Tab\` reach it`, `hide it; \`${number}\` and \`Tab\` skip it`),
  };
}

/** The last row of a view's group: which end of its list is at the top. */
function listOrder(key: keyof Settings, view: string, what: string): Row {
  return {
    key,
    group: view,
    label: "order",
    description: `Whether the ${view} list shows the newest or the oldest ${what} at the top. Oldest first reads like Claude Code, from the top down; newest first puts the latest right under the tabs, where a long list starts. The keys follow what you see: \`↑/↓\` go up and down the list, \`Home\` and \`g\` to the top, \`End\` and \`G\` to the bottom.`,
    values: [
      ["oldest-first", `oldest at the top, newest at the bottom: new ${what} appear below`],
      ["newest-first", `newest at the top, oldest at the bottom: new ${what} appear at the top`],
    ],
    viewKey: `\`s\` in ${view}`,
  };
}

/** A view's row for how far back its list reaches at first. */
function listRange(key: keyof Settings, view: string, what: string, dated: string): Row {
  return {
    key,
    group: view,
    label: "range",
    description: `How far back the ${view} list reaches when it is read: the ${what} ${dated} today or in the days before it, counted in calendar days from midnight. A short range opens faster when there are many transcripts: those last written before it are not read. The list shows the newest at the top and ends with "↓ more ↓", which reads the rest until the viewer restarts.`,
    values: RANGE_VALUES.map((v): [string, Text] => [
      v,
      v === "all"
        ? "the whole history, without ↓ more ↓; the first read takes longer with many transcripts"
        : v === "today"
          ? (c) => `only today, since ${firstDay(v, c.now)} 00:00`
          : (c) => `today and the ${Number.parseInt(v, 10) - 1} days before, since ${firstDay(v, c.now)} 00:00`,
    ]),
  };
}

/** What Enter opens in each view whose detail can show over the whole pane. */
const DETAIL_OF: Record<string, string> = {
  Chat: "`Enter` shows the full prompt and `a` a subagent's page",
  Changes: "`Enter` shows the whole file",
  Plan: "`Enter` shows the plan's changes",
  Monitor: "`Enter` shows the response table",
};

/** A view's row for the width of its list, next to the preview; `suits` says what a wider list is good for there. */
function listWidthRow(key: keyof Settings, group: string, label: string, view: string, suits: string): Row {
  const share = (w: ColumnWidth) => `${LIST_WIDTHS[w].share * 100} % of the pane, ${LIST_WIDTHS[w].min}–${LIST_WIDTHS[w].max} columns`;
  return {
    key,
    group,
    label,
    description: `How wide the ${view} list is; the preview takes the rest of the pane. ${suits} The preview keeps at least 20 columns, so in a narrow pane the wider steps stop there. At the ends one of them takes the whole pane: hidden to read the preview in full width, full to read the list's entries uncut.`,
    values: [
      ["hidden", "the list is folded away, the preview takes the whole pane; `↑` `↓` still switch entries"],
      ["narrow", `${share("narrow")}: more room for the preview`],
      ["normal", share("normal")],
      ["wide", share("wide")],
      ["wider", `${share("wider")}: the list and the preview share the pane`],
      [
        "full",
        DETAIL_OF[view]
          ? `the list takes the whole pane, without a preview; ${DETAIL_OF[view]} over the whole pane, \`Esc\` goes back to the list`
          : "the list takes the whole pane, without a preview",
      ],
    ],
    viewKey: `\`<\`, \`>\` and \`|\` in ${view}`,
    notes: [
      "`<` and `>` step one width at a time, from hidden to full. `|` goes from a width to hidden, and on the next press back to that width; the press after that goes to full, and the next back again. After a restart, the width before is not known: `|` then goes from hidden to narrow and from full to wider.",
      "Every step is stored here, hidden and full too: the view starts as you left it.",
      ...(view === "Settings" ? ["With hidden, this list is gone as soon as you choose it; `|` or `>` brings it back."] : []),
    ],
  };
}

/** A view's wrap setting: long lines wrap at the pane's edge or are cut and scroll sideways. */
function wrapRow(key: keyof Settings, group: string, what: string, off: string): Row {
  return {
    key,
    group,
    label: "wrap",
    description: `Whether long lines ${what} wrap at the edge of the pane; off, they are cut and \`Ctrl+←/→\` scrolls sideways.`,
    values: ON_OFF("wrap at the edge; nothing is cut off", `cut at the edge, \`Ctrl+←/→\` scrolls; ${off}`),
    viewKey: `\`w\` in ${group}`,
  };
}

/** Every setting the view offers, by group; the list and the details come from here. */
export const SETTING_ROWS: Row[] = [
  {
    key: "autoOpen",
    group: "Start",
    label: "auto open",
    description:
      "Whether the viewer opens by itself when Claude Code starts (also with `--resume` and `--continue`). The focus stays in Claude Code, and a Claude Code that already has a viewer gets no second one. With remember, the viewer is where you left it: open in the projects you want it in, closed in the others.",
    values: AUTO_OPEN_VALUES.map((v) => [v, AUTO_OPEN_MEANINGS[v]]),
    notes: [
      (c) =>
        c.terminal
          ? `Needs the plugin's hooks, and Windows Terminal or tmux (here: ${c.terminal === "wt" ? "Windows Terminal" : "tmux"}).`
          : "Needs the plugin's hooks, and Windows Terminal or tmux; neither is found here, so it does not open.",
      "Takes effect at the next start of Claude Code.",
    ],
  },
  {
    key: "placement",
    group: "Start",
    label: "placement",
    description:
      "Where the viewer opens, when Claude Code starts and with `/cco:…` commands. right and left suit a wide screen, where both fit side by side; window keeps Claude Code at full width, for a narrow one. `p` in the viewer moves it to another place and remembers that place for the session; this setting is for sessions without one.",
    values: PLACEMENT_VALUES.map((v) => [v, PLACEMENT_DETAILS[v]]),
    notes: [
      (c) => (c.terminal === "tmux" ? "" : "A window takes the focus from Claude Code: Windows Terminal cannot hand it back to another window."),
      "Takes effect the next time the viewer opens; a running viewer stays where it is.",
    ],
  },
  {
    key: "confirmQuit",
    group: "General",
    label: "confirm quit",
    description:
      "Whether `q` and `Esc` ask before the viewer closes, so a key meant for Claude Code but typed in the viewer's pane does not close it, and whether restart the viewer (Reset, below) asks before it restarts. The viewer still closes by itself when the session ends; `/cco:chat` opens it again. `/cco:restart` never asks.",
    values: ON_OFF("ask first: Quit cco? or Restart the viewer? `Enter` yes, `Esc` no", "close at the first `q` or `Esc`; restart the viewer restarts without asking"),
  },
  {
    key: "marquee",
    group: "General",
    label: "marquee",
    description:
      "Whether the selected list entry scrolls sideways when it is too long for the list, at most 250 columns, then from the start. Useful in a narrow pane, where prompts, paths and session titles are cut.",
    values: ON_OFF(
      "the selected entry scrolls to its end and starts over; the others are cut with …",
      "every entry is cut with …, e.g. Fix the date separa…; the preview's header shows it in full",
    ),
  },
  {
    key: "dateSeparators",
    group: "General",
    label: "date separators",
    description:
      "Whether Chat, Plan, Sessions and the trash show a line with the date (── Mon 28 Sep 2026 ──) above each day's entries, unless all of them are from today; the entries then show only their time. The Monitor's days get a line per year (── 2025 ──) once they reach into another year. Off, Sessions and the trash show the date in each row again.",
    values: ON_OFF(
      (c) => `a line per day, e.g. ── ${daysAgo(1, c.now)} ── above yesterday's entries; the rows show only 14:32`,
      (c) => `no lines; Sessions and the trash show ${dayOf(new Date(c.now.getFullYear(), c.now.getMonth(), c.now.getDate() - 1).getTime())!.slice(5)} 14:32 in each row`,
    ),
  },
  {
    key: "pinnedFavorites",
    group: "General",
    label: "pinned favorites",
    description:
      "Whether every list (Chat, Changes, Plan, Sessions, Monitor and Settings) shows its marked entries (`Space`) once more at the top, under ── ★ Pinned ──, in the order of the list, and below that the whole list, after a plain line or its first date separator, where they keep their place, with their ★ as well. `↑↓` and `Home`/`End` follow the rows on screen, through both copies; `Shift+↑/↓` only the pinned ones. Following the newest entry selects it in its place in the list. A filter applies to them too. Sessions and the Monitor pin only what their range has read; Sessions also pins the active and running sessions while pinned sessions is on. Useful to keep a few entries at hand in a long list: the turn with the task you work on, a file you keep checking, the settings you change often.",
    values: ON_OFF(
      "marked entries once more at the top, under ── ★ Pinned ──, and in their place below, both with ★",
      "marked entries only in their place, with ★; `Shift+↑/↓` jumps between them",
    ),
  },
  {
    key: "rememberPositions",
    group: "General",
    label: "remember positions",
    description: "Whether every list keeps its selected entry and the scroll position of each entry across restarts of the viewer. Switching entries keeps positions either way while the viewer runs.",
    values: ON_OFF(
      "store them per project, e.g. Changes reopens on the same file, scrolled to the same hunk",
      "start fresh after each restart: the newest turn in Chat, the first entry elsewhere, each scrolled to the top",
    ),
    notes: [(c) => `Stored in \`${tilde(positionsFile(c.cwd))}\`; switching off keeps the file.`, "Takes effect when the viewer starts."],
  },
  {
    key: "rememberView",
    group: "General",
    label: "view per session",
    description:
      "Whether each session comes back in the view it was shown in last (Chat, Changes, Plan, Sessions or Settings): when Claude Code starts or resumes it, when you start the viewer with `/cco:open` or without `--view`, and when the viewer follows it after `/resume`. A `/cco:…` command still opens the view it names.",
    values: ON_OFF(
      "reopen the session's last view, e.g. a session left in Changes comes back in Changes after `claude --resume`",
      "start in the chat, or the view shown last in the project",
    ),
    notes: [(c) => `Stored per project in \`${tilde(sessionViewsFile(c.cwd))}\`.`],
  },
  {
    key: "mouse",
    group: "General",
    label: "mouse",
    description: (c) =>
      `Whether the viewer takes the mouse: a click on a tab switches to it, a click on a web address opens it in the browser, a click in a list selects the entry, a double click does what \`Enter\` does, and the wheel scrolls the preview (or moves through the list). A drag in the preview selects lines and copies them when released. While it is on, the terminal leaves clicks to the viewer: ${selectText(c.terminal)}.`,
    values: ON_OFF("clicks and wheel go to the viewer", (c) =>
      c.terminal === "tmux" ? "tmux and the terminal keep the mouse, as in any other pane" : "the terminal keeps the mouse: a drag selects text, `Ctrl+click` opens links",
    ),
  },
  {
    key: "filterIn",
    group: "General",
    label: "filter in",
    description:
      "What the list filter (`Ctrl+F`) looks at. The list: what an entry's row shows (prompt, file path, plan or session title, day, setting name). The details: what its preview adds (attached files and subagents, the plan text and feedback, a session's prompts, files and branch, the models of a day, a setting's description). For example, with the details, `src/tui` in Sessions finds the sessions that changed a file there, although no row shows it. Every word must match, in any order; `*` stands for any characters, `?` for one. In the filter dialog, `^L` and `^D` switch them on and off, which changes this setting.",
    values: FILTER_IN_VALUES.map((v) => [v, FILTER_IN_MEANINGS[v]]),
  },
  {
    key: "updateMode",
    group: "General",
    label: "update",
    description:
      "Whether the viewer asks npm for the latest version of cco and GitHub for the release notes when it starts. A newer version shows in the top bar, and the Releases entries at the end of the list show the notes of each version and run the update. With auto, the viewer also opens the update here as soon as the check finds one and asks whether to install it. Choose on to update when it suits you, off without network access.",
    values: UPDATE_VALUES.map((v) => [v, UPDATE_MEANINGS[v]]),
    notes: ["`F5` in Settings checks once either way.", "The answer is kept in `~/.claude/cco/releases.json`, so the notes also show offline."],
  },
  viewTab("viewChat", "Chat", "1", "the session's turns, rendered as Markdown"),
  listWidthRow("chatListWidth", "Chat", "list width", "Chat", "A wider list shows more of each prompt; a narrower one leaves the answers more room, e.g. for wide tables and code."),
  {
    key: "showTools",
    group: "Chat",
    label: "tool calls",
    description:
      "How much the chat shows of Claude's tool calls (reads, edits, commands, searches) between the text. compact shows what Claude did at a glance, full also what came out. With it off, Claude's questions and your answers (AskUserQuestion) still show, in a yellow frame, and what Claude did in the browser (Claude in Chrome, the desktop app's Browser pane) in a cyan one, with numbered screenshots that a click or `o` / `O` opens; otherwise they are tool calls like the others.",
    values: [
      ["off", "hide them; Claude's text reads as one answer"],
      ["compact", "a line each, with the result, e.g. ⚙ Read src/app.ts · 120 lines, ⚙ Edit src/app.ts · +4 −2, ⚙ Bash Run the tests · ✓ · 38 lines"],
      ["full", "also the command, the last 10 lines of its output, and the first 5 files a search found"],
    ],
    viewKey: "`t` in Chat",
  },
  {
    key: "showThinking",
    group: "Chat",
    label: "thinking",
    description: "Whether the chat shows Claude's thinking blocks: what it considered before an answer or a tool call. Useful to see why Claude took a path; the turns get much longer.",
    values: ON_OFF("show them where Claude thought, between the text", "hide them; only what Claude wrote to you"),
    viewKey: "`h` in Chat",
  },
  {
    key: "showAgents",
    group: "Chat",
    label: "agents",
    description:
      "Whether the chat shows the subagents Claude started, where it started them: type, task, model, and whether they are running, finished or failed, with their duration, tool uses and tokens. `a` in Chat opens what a subagent did.",
    values: ON_OFF("show them, e.g. an Explore agent searching the code, with its status", "hide them; `a` still opens what they did"),
  },
  wrapRow("chatWrap", "Chat", "in the chat", "useful for wide tables and code blocks"),
  listOrder("chatOrder", "Chat", "turns"),
  viewTab("viewGit", "Changes", "2", "the changed files with their diffs"),
  listWidthRow("gitListWidth", "Changes", "list width", "Changes", "A wider list shows long paths in full, e.g. `src/tui/SettingsView.tsx` deep in a folder; a narrower one leaves the diffs more room."),
  wrapRow("wrap", "Changes", "in diffs", "long lines of code keep their shape and indentation"),
  viewTab("viewPlan", "Plan", "3", "the plans Claude presented in plan mode"),
  listWidthRow("planListWidth", "Plan", "list width", "Plan", "A wider list shows more of each plan's title; a narrower one leaves the plan text more room."),
  wrapRow("planWrap", "Plan", "of plans", "useful for wide tables and code blocks"),
  listOrder("planOrder", "Plan", "plans"),
  viewTab("viewSessions", "Sessions", "4", "the overview of past sessions"),
  listWidthRow("sessionsListWidth", "Sessions", "list width", "Sessions", "A wider list shows more of each session's title or first prompt, also in the trash; a narrower one leaves the prompts and files of the preview more room."),
  {
    key: "allProjects",
    group: "Sessions",
    label: "all projects",
    description: "Whether the Sessions view lists the sessions of all projects or only of this one. All projects helps to find a session started in another folder; the trash follows the same choice.",
    values: ON_OFF("all projects with sessions in `~/.claude/projects`", (c) => `only this one, ${basename(c.cwd) || c.cwd}`),
    viewKey: "`a` in Sessions",
  },
  {
    key: "pinnedSessions",
    group: "Sessions",
    label: "pinned sessions",
    description:
      "Whether the Sessions view shows the active session (●) and those running in another Claude Code (▶) in the Pinned group at the top, marked or not, so they stay at hand however far down the list their last prompt puts them. This works with pinned favorites off too: the group then holds only them; with it on, they mix with the marked sessions in the order of the list. A session that ends leaves the group. A filter applies to them too.",
    values: ON_OFF(
      "the active and running sessions once more at the top, under ── ★ Pinned ──, with ● or ▶",
      "they show only in their place in the list, with ● or ▶",
    ),
  },
  listRange("sessionsRange", "Sessions", "sessions", "started"),
  viewTab("viewMonitor", "Monitor", "5", "response speed, wait and errors over the day"),
  listWidthRow("monitorListWidth", "Monitor", "list width", "Monitor", "The days need little room, so narrow leaves the charts and the response table more columns."),
  {
    ...listRange("monitorRange", "Monitor", "days", "with responses"),
    notes: ["The usual values (the median of the 30 days before a day) come from the days read, so a short range has fewer of them."],
  },
  listWidthRow("settingsListWidth", "Settings", "list width", "Settings", "A wider list cuts fewer labels; a narrower one leaves the descriptions more room."),
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
  const wrap = (text: string, indent = "") => wrapText(text, width, indent);
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
  lines.push("", dim(codeMarks("`Enter` asks before anything is changed.")));
  return lines;
}

/** Wraps report lines, keeping each line's indentation for its continuation. */
function wrapIndented(lines: string[], width: number): string[] {
  return lines.flatMap((line) => {
    const indent = /^ */.exec(line)![0];
    return wrapAnsi(line.slice(indent.length), Math.max(10, width - indent.length), { hard: true })
      .split("\n")
      .map((l) => indent + l);
  });
}

/** A repair started in the doctor's entry: each step, and whether all are done. */
export interface DoctorRun {
  results: RepairResult[];
  status: "running" | "done" | "failed";
}

/** The result of a check started with Enter: the findings, and when. */
export interface DoctorCheck {
  findings: Finding[];
  at: number;
}

/** A check under way: the group being checked. */
export interface DoctorChecking {
  current: DoctorGroup;
}

/** The check's progress dialog: the group being checked. */
export function checkProgress(checking: DoctorChecking): Progress {
  const at = DOCTOR_GROUPS.indexOf(checking.current);
  return { title: "Doctor", status: "running", text: "Checking", step: { label: checking.current, at: at + 1, of: DOCTOR_GROUPS.length } };
}

/** The doctor's details: what it does, the repair while it runs, then the report of the last check (the dialog shows a check under way). */
function doctorLines(action: ResetAction, check: DoctorCheck | undefined, checking: DoctorChecking | undefined, run: DoctorRun | undefined, width: number): string[] {
  const wrap = (text: string, indent = "") => wrapText(text, width, indent);
  const lines = [...wrap(action.description)];
  if (run) {
    lines.push("", bold("Repair"));
    for (const r of run.results) {
      const mark = r.status === "done" ? GREEN("✓") : r.status === "failed" ? RED("✗") : r.status === "running" ? YELLOW("●") : dim("○");
      lines.push(...wrap(`${mark} ${r.step.command ?? r.step.label}`, "  "));
      if (r.status === "running" || r.status === "failed") for (const l of outputTail(r.output, 12)) lines.push(...wrapText(dim(l), width, "      ", false));
    }
    if (run.status === "running") lines.push("", dim("Repairing…"));
  }
  if (checking) return lines;
  if (!check) return [...lines, "", dim(codeMarks("Not checked yet. `Enter` asks, then checks."))];
  lines.push(...wrapIndented(reportLines(check.findings, true), width), "");
  const repairable = countFindings(check.findings).repairable;
  lines.push(dim(codeMarks(repairable > 0 ? `\`Enter\` asks, then repairs ${repairable} of them. \`F5\` checks again.` : "Nothing to repair. `Enter` or `F5` checks again.")));
  return lines;
}

export function settingLines(row: Row, current: string | boolean, width: number, context: TextContext): string[] {
  const wrap = (text: string, indent = "") => wrapText(text, width, indent);
  const lines = [...wrap(textOf(row.description, context)), ""];
  lines.push(bold("Values"));
  for (const [value, meaning] of row.values) {
    // A blank line below the heading and between the values: most take two or three lines with their example.
    lines.push("");
    const selected = value === current;
    const name = valueName(value) + (value === DEFAULT_SETTINGS[row.key] ? " (default)" : "");
    // The value on a line of its own, what it does indented below it.
    // Names in colour, so they stand out from their descriptions: the current one green, the others gray.
    lines.push(selected ? `\u001b[32m● ${name}\u001b[39m` : `${dim("○")} \u001b[90m${name}\u001b[39m`, ...wrap(textOf(meaning, context), "  "));
  }
  if (row.viewKey) lines.push("", dim(codeMarks(`Also ${row.viewKey}.`)));
  for (const note of (row.notes ?? []).map((n) => textOf(n, context)).filter(Boolean)) lines.push("", ...wrap(dim(note)));
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
const newerReleases = (update: Update) => update.releases.filter((r) => compareVersions(r.version, VERSION) > 0);
const day = (iso?: string) => (iso ? iso.slice(0, 10) : undefined);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The update's progress dialog: the step running, then the restart, or where it stopped. */
export function updateProgress(run: UpdateRun, copy?: () => void, onClose?: () => void): Progress {
  const steps: ProgressStep[] = run.steps.map((s) => ({ label: s.step.label, status: s.status, output: s.output }));
  const title = `Update cco to v${run.target}`;
  if (run.status === "running") return { title, status: "running", text: "Updating", step: currentStep(steps) };
  if (run.status === "failed")
    return {
      title,
      status: "failed",
      text: `The update stopped at ${stepText(currentStep(steps))}`,
      lines: [...failureLines(steps), "Run the rest by hand, then reopen the viewer."],
      copy,
      onClose,
    };
  if (run.reopenFailed)
    return {
      title,
      status: "done",
      text: `Updated to v${run.target}`,
      lines: [REOPEN_BY_HAND, "Restart Claude Code for the plugin."],
      onClose,
    };
  return { title, status: "waiting", text: "Restarting", detail: `Updated to v${run.target}` };
}

/** The commands of the repairs that failed, to run by hand. */
export function failedRepairCommands(run: DoctorRun): string[] {
  return run.results.flatMap((r) => (r.status === "failed" && r.step.command ? [r.step.command] : []));
}

/** The repair's progress dialog: the step running, or the steps that failed (c copies their commands, if any). */
export function repairProgress(run: DoctorRun, copy?: () => void, onClose?: () => void): Progress {
  const steps: ProgressStep[] = run.results.map((r) => ({ label: r.step.label, status: r.status, output: r.output }));
  const title = "Repair";
  if (run.status === "failed") {
    const failed = steps.filter((s) => s.status === "failed").length;
    return {
      title,
      status: "failed",
      text: `${failed} of ${plural(steps.length, "repair")} failed`,
      lines: [...failureLines(steps), "The report shows what is left."],
      copy: failedRepairCommands(run).length > 0 ? copy : undefined,
      onClose,
    };
  }
  return { title, status: "running", text: "Repairing", step: currentStep(steps) };
}

/** The update entry's details: what Enter does, the steps while they run, then the notes of the newer releases. */
function updateLines(update: Update, width: number): string[] {
  const wrap = (text: string, indent = "") => wrapText(text, width, indent);
  const { state, run } = update;
  const commands = UPDATE_STEPS.map((s) => `  ${codeSpan(s.command)}`);
  const lines: string[] = [];
  if (run) {
    for (const s of run.steps) {
      const mark = s.status === "done" ? GREEN("✓") : s.status === "failed" ? RED("✗") : s.status === "running" ? YELLOW("●") : dim("○");
      lines.push(...wrap(`${mark} ${s.step.label}: \`${s.step.command}\``));
      if (s.status === "running" || s.status === "failed") for (const l of outputTail(s.output, 12)) lines.push(...wrapText(dim(l), width, "    ", false));
    }
    lines.push("");
    if (run.status === "failed")
      lines.push(...wrap("The update stopped. Run the rest by hand (`c` copies it), then close the viewer with `q` and open it again:"), ...remainingCommands(run.steps).map((c) => `  ${codeSpan(c)}`));
    else if (run.status === "done")
      lines.push(...wrap(`Updated to v${run.target}. The viewer opens again with it; if it does not, close it with \`q\` and open it again. Restart Claude Code for the plugin.`));
    else lines.push(dim("Updating…"));
  } else if (state.kind === "update") {
    lines.push(
      ...wrap(`v${state.target} is out; this is v${VERSION}. \`Enter\` asks, then runs:`),
      ...commands,
      "",
      ...wrap(dim("Then the viewer opens again with the new version. The plugin (hooks, `/cco:…` commands) takes effect when Claude Code restarts.")),
    );
  } else if (state.kind === "restart") {
    lines.push(...wrap(`v${state.target} is installed; this viewer still runs v${VERSION}. \`Enter\` opens it again with the new version.`));
  } else if (state.kind === "dev") {
    lines.push(
      ...wrap(`v${state.target} is out; this is v${VERSION}, run from \`${tilde(update.root)}\` (\`npm link\` or \`npx\`), which cco does not update. Update the checkout, or install the release (\`c\` copies it):`),
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
    : update.mode === "off" && update.checkedAt === undefined
      ? "The update check is off (General: update), so cco has not asked GitHub for the release notes. `F5` checks once."
      : "npm and GitHub could not be reached. `F5` tries again.";
  return wrapText(text, width);
}

/** What a restart runs: the version on disk, which differs from the running one after an update. */
function restartDetail(root: string): string {
  const installed = root ? installedVersion(root) : undefined;
  return installed && installed !== VERSION ? `v${installed} (running v${VERSION})` : `v${installed ?? VERSION}`;
}

/** The list: the settings, the reset actions, then the releases (the last group, since it grows). */
export function settingsEntries(update: Update): Entry[] {
  return [...SETTING_ROWS, ...RESET_ACTIONS, ...releaseEntries(update)];
}

export function SettingsView({ layout, active, onModal, onTyping, cwd, onResetData, onRestart, select: asked }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const [isDoubleClick] = useState(() => doubleClicks());
  const settings = useSettings();
  // The examples' dates are today's; a new day writes them anew on the next render.
  const today = dayOf(Date.now());
  const context = useMemo((): TextContext => ({ now: new Date(), cwd, terminal: detectTerminal() }), [cwd, today]);
  const update = useUpdateInfo();
  const copy = useClipboard();
  const [copied, setCopied] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  // The app's progress dialog takes the keys while it is open.
  const progressOpen = useProgressOpen();
  const positions = usePositions(cwd, "settings");
  // The doctor checks only when asked to (Enter, a double click), again after a repair and on F5 once it has checked.
  const [doctorCheck, setDoctorCheck] = useState<DoctorCheck>();
  const [doctorChecking, setDoctorChecking] = useState<DoctorChecking>();
  // A newer check (F5 during one) makes the older one stop.
  const checkRun = useRef(0);
  const [doctorRun, setDoctorRun] = useState<DoctorRun>();
  // The progress dialogs of the update and the repair: open from the confirmation until Esc after the end
  // (a repair that worked closes its own; a successful update ends with the viewer).
  const [updateDialog, setUpdateDialog] = useState(false);
  const [repairDialog, setRepairDialog] = useState(false);
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
    if (doctorCheck) void runCheck();
    void update.recheck().then(done);
  });
  const marked = entries.filter((e) => favorites.isMarked(e)).length;
  // A setting is found by its value, group and name as listed; its details are what it does.
  const filter = useListFilter({
    items: listEntries,
    text: (e) =>
      "key" in e
        ? { list: haystack([valueName(settings[e.key]), e.group, e.label]), details: plainMarks(textOf(e.description, context)) }
        : "id" in e
          ? { list: haystack(["Reset", e.label]), details: plainMarks(e.description) }
          : e.kind === "release"
            ? { list: haystack(["Releases", e.release.tag, e.release.title]), details: e.release.body }
            : { list: haystack(["Releases", entryLabel(e)]), details: "" },
    deps: [settings, update.releases, update.state, context],
    selected: index,
    select: (i) => select(i),
    layout,
    onTyping,
    marked: (e) => favorites.isMarked(keyOf(e)),
    restoreCopy: positions.pinned ? (e) => keyOf(e) === positions.selected : undefined,
  });

  const updating = update.run?.status === "running";
  // A check or a repair of the doctor under way.
  const doctorBusy = doctorRun?.status === "running" || doctorChecking !== undefined;
  const repairOpen = repairDialog && doctorRun !== undefined && doctorRun.status !== "done";
  // While the update, a check or a repair runs, the app keeps q, p and the other views away from it.
  const modal = confirmation !== undefined || updating || doctorBusy;
  useEffect(() => {
    onModal?.(modal);
  }, [modal]);
  useEffect(() => positions.select(entryKey, undefined, filter.copySelected), [entryKey, filter.copySelected]);
  useEffect(() => {
    if (!asked) return;
    setSelectedKey(entries[resolveKey(asked.key, listEntries)]);
    if (asked.ask && canUpdate) askUpdate();
  }, [asked?.at]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const changed = SETTING_ROWS.filter((r) => settings[r.key] !== DEFAULT_SETTINGS[r.key]);
  const canReset = changed.length > 0 || marked > 0;
  const saved = useMemo(() => (reset?.id === "data" ? projectData(cwd) : []), [reset?.id, cwd, confirmation]);
  const findings = doctorCheck?.findings ?? [];
  const repairs = repairsOf(findings);
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
    if (e.kind === "releases") return previewHeader("Releases", previewWidth, { marker: "◆ ", style: bold, details: [`update ${update.mode}`] });
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
          ? previewHeader(reset.id === "doctor" ? "Doctor" : `Reset: ${reset.label}`, previewWidth, {
              marker: reset.id === "doctor" ? "✚ " : "↺ ",
              style: bold,
              details: [
                reset.id === "doctor"
                  ? doctorChecking
                    ? "checking…"
                    : doctorCheck
                      ? `${countText(findings)} · checked ${new Date(doctorCheck.at).toTimeString().slice(0, 5)}`
                      : "not checked yet"
                  : reset.id === "settings"
                    ? `${changed.length} changed${marked > 0 ? ` · ${marked} marked` : ""}`
                    : reset.id === "data"
                      ? `${saved.length} of 4 files saved`
                      : restartDetail(update.root),
              ],
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
    [entry, update, current, changed.length, marked, saved.length, doctorCheck, doctorChecking, previewWidth, bodyHeight],
  );
  const lines = useMemo(
    () =>
      reset
        ? reset.id === "doctor"
          ? doctorLines(reset, doctorCheck, doctorChecking, doctorRun, previewWidth)
          : resetLines(reset, changed.map((r) => `${r.group} ${r.label}`), marked, saved, previewWidth)
        : release
          ? release.kind === "update"
            ? updateLines(update, previewWidth)
            : release.kind === "release"
              ? releaseLines(release.release, previewWidth)
              : releasesNote(update, previewWidth)
          : settingLines(row!, current!, previewWidth, context),
    [entry, update, current, changed.length, marked, saved, doctorCheck, doctorChecking, doctorRun, previewWidth, context],
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
  /** Checks group by group, each after a short pause that shows which one is being checked. */
  async function runCheck() {
    const run = ++checkRun.current;
    const findings: Finding[] = [];
    for (const group of DOCTOR_GROUPS) {
      setDoctorChecking({ current: group });
      await new Promise((resolve) => setTimeout(resolve, TIMING.checkStep));
      if (run !== checkRun.current) return;
      findings.push(...diagnoseGroup(group, { cwd }));
    }
    setDoctorChecking(undefined);
    setDoctorCheck({ findings, at: Date.now() });
  }
  const askCheck = () =>
    setConfirmation({
      title: "Run the doctor?",
      lines: [
        "Checks the installation, cco's files in ~/.claude/cco, the settings, the terminal and the hooks.",
        "Nothing is changed: repairs are offered with the report.",
      ],
      onConfirm: () => void runCheck(),
    });
  const askRepair = () =>
    setConfirmation({
      title: `Repair ${plural(countFindings(findings).repairable, "finding")}?`,
      lines: repairs.map((r) => `· ${r.label}`),
      onConfirm: () => {
        setRepairDialog(true);
        setDoctorRun({ results: [], status: "running" });
        void runRepairs(repairSteps(repairs), (results) => setDoctorRun({ results, status: "running" })).then((ok) => {
          setDoctorRun((run) => run && { ...run, status: ok ? "done" : "failed" });
          void runCheck();
        });
      },
    });
  const askRestart = () =>
    setConfirmation({
      title: "Restart the viewer?",
      lines: [`It opens again here, in this view, with ${restartDetail(update.root)}.`, "Claude Code keeps running; restart it for changes to the plugin."],
      onConfirm: () => onRestart?.(),
    });
  // Like q: with confirm quit off, no question. The app shows the restart's progress.
  const restart = () => (settings.confirmQuit ? askRestart() : onRestart?.());
  const { state } = update;
  const canUpdate = state.kind === "update" && !updating && update.run?.status !== "done";
  const askUpdate = () =>
    state.kind === "update" &&
    setConfirmation({
      title: `Update cco to v${state.target}?`,
      lines: [...UPDATE_STEPS.map((s) => s.command), "Then the viewer opens again with the new version."],
      onConfirm: () => {
        setUpdateDialog(true);
        update.start();
      },
    });
  // What c copies on the update entry: the commands still to run.
  const commandsToCopy = update.run?.status === "failed" ? remainingCommands(update.run.steps) : UPDATE_STEPS.map((s) => s.command);
  const onUpdate = release?.kind === "update";
  const copyCommands = () => void copy(commandsToCopy.join("\n")).then(() => setCopied(true));
  const copyRepairCommands = () => doctorRun && void copy(failedRepairCommands(doctorRun).join("\n")).then(() => setCopied(true));
  // A check shows its dialog too; after a repair that failed, that one stays in front.
  useProgress(
    updateDialog && update.run
      ? updateProgress(update.run, copyCommands, () => setUpdateDialog(false))
      : repairOpen
        ? repairProgress(doctorRun, copyRepairCommands, () => setRepairDialog(false))
        : doctorChecking && checkProgress(doctorChecking),
  );

  /** Enter (or a double click) on the selected entry: a reset or the update asks first, a setting takes its next value. */
  const activate = () => {
    if (filter.none) return;
    if (reset) {
      if (reset.id === "settings") return canReset && askResetSettings();
      if (reset.id === "restart") return onRestart !== undefined && restart();
      // Checked with problems to repair: Enter offers the repair; else it checks (again).
      if (reset.id === "doctor") return !doctorBusy && (repairs.length > 0 ? askRepair() : askCheck());
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
      if (onUpdate && input === "c") return copyCommands();
      if (input === "r" && row) return set({ [row.key]: DEFAULT_SETTINGS[row.key] });
      if (input === "R" && canReset) return askResetSettings();
      handleNavigation(input, key, { ...filter.nav, scroll, page: viewport - 2 });
    },
    { isActive: active && confirmation === undefined && !progressOpen && !filter.open },
  );

  /** What a row shows: the label, and at its right end the value (or mark); the group is the separator above it. */
  const rowParts = (e: Entry): { value: string; color?: string; label: string } => {
    if ("key" in e) {
      const value = settings[e.key];
      return { value: shortValueName(value), color: value === DEFAULT_SETTINGS[e.key] ? undefined : "yellow", label: e.label };
    }
    if ("id" in e) return { value: e.id === "doctor" ? "✚" : "↺", label: e.label };
    if (e.kind === "release") {
      const cmp = compareVersions(e.release.version, VERSION);
      return { value: cmp === 0 ? "installed" : cmp > 0 ? "new" : "", color: cmp === 0 ? "green" : "yellow", label: entryLabel(e) };
    }
    if (e.kind === "update") return { value: state.kind === "restart" ? "↻" : "↑", color: "yellow", label: entryLabel(e) };
    return { value: "", label: entryLabel(e) };
  };

  const entryFooter = reset
    ? reset.id === "doctor"
      ? repairs.length > 0
        ? [
            { text: "↵ repair", priority: 4 },
            { text: "F5 check", priority: 3 },
          ]
        : [{ text: "↵ check", priority: 4 }]
      : [{ text: "↵ reset", priority: 4 }]
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
            onClick={(i) => isDoubleClick(i) && i === index && !modal && activate()}
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
                  <EntryText text={label} width={labelWidth} selected={isSelected} active={active && !modal} />
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
