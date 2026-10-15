import { Text, useInput } from "ink";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { ACCOUNT_DIRS_SEPARATOR, ACCOUNTS_ORDER_VALUES, AUTO_OPEN_VALUES, COMPACT_COLUMNS_VALUES, COMPACT_SPLIT_VALUES, COMPACT_VIEW_VALUES, DEFAULT_SETTINGS, FILTER_IN_VALUES, PLACEMENT_VALUES, RANGE_VALUES, SESSIONS_BACKGROUND_VALUES, SESSIONS_REMOTE_VALUES, UPDATE_VALUES, VIEW_SETTINGS, rangeStart, reloadSettings, settingsFile, updateSettings, type ColumnWidth, type CompactView, type ListRange, type Settings, type UpdateMode } from "../settings.js";
import { detectTerminal, type Terminal } from "../open.js";
import { claudeBinDir } from "../addAccount.js";
import { marketplaceSource } from "../accountSetup.js";
import { ACCOUNT_COLORS, ACCOUNT_COLOR_NAMES, avatarOfAccount, colorOfAccount, hasChosenColor, type Account, type AccountColorName } from "../account.js";
import { ALL_AVATAR_PRESETS, DEFAULT_AVATAR, emojiInputHint } from "../avatar.js";
import { AvatarDialog } from "./AvatarDialog.js";
import { legendMark, SESSION_LEGEND } from "./sessionLegend.js";
import { filterAccounts, SessionFilterDialog } from "./SessionFilterDialog.js";
import { filterSettings, sessionFilter } from "../sessionFilter.js";
import { otherAccounts } from "../accountContinue.js";
import { AccountContext, useAccountState, type AccountState } from "./useAccount.js";
import { claudeDir, positionsFile, sessionViewsFile } from "../transcript/locate.js";
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
import { ownSession, useAccountFlow } from "./useAccountFlow.js";
import { renderMarkdown } from "../render/markdown.js";
import { codeSpan } from "../render/terminal.js";
import { countFindings, countText, diagnoseGroup, DOCTOR_GROUPS, repairsOf, repairSteps, reportLines, runRepairs, type DoctorGroup, type Finding, type RepairResult } from "../doctor.js";
import { compareVersions, installedVersion, remainingCommands, UPDATE_STEPS, type Release } from "../update.js";
import { VERSION } from "../version.js";
import { useClipboard } from "./useClipboard.js";
import { useUpdateInfo, type Update, type UpdateRun } from "./useUpdate.js";
import { TIMING } from "../timing.js";
import { L, language, LANGUAGE_NAMES, systemLanguage, type Language } from "../i18n/index.js";
import type { Messages } from "../i18n/en.js";
import { TOOL_LEVELS } from "../transcript/tools.js";

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
  /** The transcript of the viewer's session, which can continue in another account; undefined with `noSession` saying why. */
  sessionPath?: string;
  noSession?: string;
  /** The Claude Code process the viewer belongs to. */
  claudePid?: number;
}

/** The entries of the Reset group below the settings: actions, run with Enter after a confirmation. */
interface ResetAction {
  id: "doctor" | "settings" | "data" | "restart";
  label: string;
  description: string;
}

const RESET_IDS: ResetAction["id"][] = ["restart", "doctor", "settings", "data"];

/** The Reset entries in the current language. */
export function resetActions(): ResetAction[] {
  const texts = L().settings.reset;
  return RESET_IDS.map((id) => ({ id, ...texts[id] }));
}

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

/** The groups of the list, by the name the code knows them by; shown in the current language (`groupName`). */
type Group = keyof Messages["settings"]["groups"];

/** A group's name as the list shows it. */
export const groupName = (group: string): string => L().settings.groups[group as Group] ?? group;

interface Row {
  key: keyof Settings;
  /** Area the setting belongs to, the list's separator above it. */
  group: Group;
  label: string;
  description: Text;
  /** The values in the order Enter steps through them, each with what it does, with an example where one helps. */
  values: [value: string | boolean, meaning: Text][];
  /** How a value's name is drawn where it says enough by itself (the colours): such a value has no meaning, one line each. */
  look?: (value: string) => string | undefined;
  /** The key that switches it in its own view, e.g. "t in Chat". */
  viewKey?: string;
  notes?: Text[];
  /** Enter opens this dialog instead of stepping through the values (which then are the ones on offer). */
  dialog?: "avatar" | "sessions";
  /** How a value of one's own (none of `values`) is named, and what it means; else as it is, "your own". */
  ownName?: (value: string) => string;
  ownMeaning?: (value: string) => string;
  /** The details end with the marks of the Sessions list. */
  legend?: boolean;
  /** Short values with short meanings: one line each, the meaning after the value. */
  inline?: boolean;
}

const ON_OFF = (on: Text, off: Text): Row["values"] => [
  [true, on],
  [false, off],
];

/** "Thu 24 Sep" for the day `days` before today. */
const daysAgo = (days: number, now: Date) => dayLabel(dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime())!, "always");

/** "Thu 24 Sep" for the first day `range` covers. */
const firstDay = (range: ListRange, now: Date) => dayLabel(dayOf(rangeStart(range, now))!, "other", now.getTime());

/** The meaning of each value of a choice, from the row's texts by value. */
function meanings<V extends string>(values: readonly V[], texts: Record<V, Text>): Row["values"] {
  return values.map((v) => [v, texts[v]]);
}

/** The placements as the placement dialog (p) names them. */
export const placementMeaning = (placement: (typeof PLACEMENT_VALUES)[number]): string => L().settings.rows.placement.meanings[placement] ?? placement;

/** The first row of a view's group: whether the view has a tab. */
function viewTab(key: keyof Settings, group: Group, number: string, what: string): Row {
  const t = L().settings.common;
  return {
    key,
    group,
    label: t.tab,
    description: t.tabDescription(groupName(group), what, number),
    values: ON_OFF(t.tabOn(number), t.tabOff(number)),
  };
}

/** The last row of a view's group: which end of its list is at the top. */
function listOrder(key: keyof Settings, group: Group, what: string): Row {
  const t = L().settings.common;
  return {
    key,
    group,
    label: t.order,
    description: t.orderDescription(groupName(group), what),
    values: [
      ["oldest-first", t.oldestFirst(what)],
      ["newest-first", t.newestFirst(what)],
    ],
    viewKey: L().settings.inView("`s`", groupName(group)),
  };
}

/** A view's row for how far back its list reaches at first. */
function listRange(key: keyof Settings, group: Group, what: string, dated: string): Row {
  const t = L().settings.common;
  return {
    key,
    group,
    label: t.range,
    description: t.rangeDescription(groupName(group), what, dated),
    values: RANGE_VALUES.map((v): [string, Text] => [
      v,
      v === "all" ? t.rangeAll : v === "today" ? (c) => t.rangeToday(firstDay(v, c.now)) : (c) => t.rangeDays(Number.parseInt(v, 10) - 1, firstDay(v, c.now)),
    ]),
  };
}

/** A view's row for the width of its list, next to the preview; `suits` says what a wider list is good for there. */
function listWidthRow(key: keyof Settings, group: Group, label: string, suits: string): Row {
  const t = L().settings.common;
  const view = groupName(group);
  const share = (w: ColumnWidth) => t.share(LIST_WIDTHS[w].share * 100, LIST_WIDTHS[w].min, LIST_WIDTHS[w].max);
  const detail = t.detailOf[group];
  return {
    key,
    group,
    label,
    description: t.widthDescription(view, suits),
    values: [
      ["hidden", t.widthHidden],
      ["narrow", t.widthNarrow(share("narrow"))],
      ["normal", share("normal")],
      ["wide", share("wide")],
      ["wider", t.widthWider(share("wider"))],
      ["full", detail ? t.widthFullDetail(detail) : t.widthFull],
    ],
    viewKey: t.widthKeys(view),
    notes: [...t.widthNotes, ...(group === "Settings" ? [t.widthSettingsNote] : [])],
  };
}

/** A view's wrap setting: long lines wrap at the pane's edge or are cut and scroll sideways. */
function wrapRow(key: keyof Settings, group: Group, what: string, off: string): Row {
  const t = L().settings.common;
  return {
    key,
    group,
    label: t.wrap,
    description: t.wrapDescription(what),
    values: ON_OFF(t.wrapOn, t.wrapOff(off)),
    viewKey: L().settings.inView("`w`", groupName(group)),
  };
}

/** Every setting the view offers, by group, in the current language; the list and the details come from here. */
export function settingRows(): Row[] {
  const lang = language();
  if (rowsOf?.lang !== lang) rowsOf = { lang, rows: buildRows(L().settings) };
  return rowsOf.rows;
}
let rowsOf: { lang: Language; rows: Row[] } | undefined;

function buildRows(m: Messages["settings"]): Row[] {
  const r = m.rows;
  const t = m.common;
  return [
    {
      key: "autoOpen",
      group: "Start",
      label: r.autoOpen.label,
      description: r.autoOpen.description,
      values: meanings(AUTO_OPEN_VALUES, r.autoOpen),
      notes: [(c) => (c.terminal ? r.autoOpen.needs(c.terminal === "wt" ? "Windows Terminal" : "tmux") : r.autoOpen.needsNone), r.autoOpen.nextStart],
    },
    {
      key: "placement",
      group: "Start",
      label: r.placement.label,
      description: r.placement.description,
      values: [
        ["right", r.placement.right],
        ["left", r.placement.left],
        ["window", (c) => (c.terminal === "wt" ? r.placement.windowWt : c.terminal === "tmux" ? r.placement.windowTmux : r.placement.meanings.window)],
      ],
      notes: [(c) => (c.terminal === "tmux" ? "" : r.placement.focus), r.placement.next],
    },
    {
      key: "language",
      group: "General",
      label: r.language.label,
      description: r.language.description,
      values: [
        ["system", () => r.language.system(LANGUAGE_NAMES[systemLanguage()])],
        ["en", r.language.en],
        ["de", r.language.de],
      ],
      notes: [r.language.note],
      inline: true,
    },
    {
      key: "confirmQuit",
      group: "General",
      label: r.confirmQuit.label,
      description: r.confirmQuit.description,
      values: ON_OFF(r.confirmQuit.on, r.confirmQuit.off),
    },
    {
      key: "compactView",
      group: "General",
      label: r.compactView.label,
      description: r.compactView.description,
      values: meanings(COMPACT_VIEW_VALUES, r.compactView),
    },
    {
      key: "compactColumns",
      group: "General",
      label: r.compactColumns.label,
      description: r.compactColumns.description,
      values: meanings(COMPACT_COLUMNS_VALUES, r.compactColumns),
    },
    {
      key: "compactSplit",
      group: "General",
      label: r.compactSplit.label,
      description: r.compactSplit.description,
      values: meanings(COMPACT_SPLIT_VALUES, r.compactSplit),
    },
    {
      key: "marquee",
      group: "General",
      label: r.marquee.label,
      description: r.marquee.description,
      values: ON_OFF(r.marquee.on, r.marquee.off),
    },
    {
      key: "dateSeparators",
      group: "General",
      label: r.dateSeparators.label,
      description: () => r.dateSeparators.description(dayLabel("2026-09-28", "always")),
      values: ON_OFF(
        (c) => r.dateSeparators.on(daysAgo(1, c.now)),
        (c) => r.dateSeparators.off(dayOf(new Date(c.now.getFullYear(), c.now.getMonth(), c.now.getDate() - 1).getTime())!.slice(5)),
      ),
    },
    {
      key: "pinnedFavorites",
      group: "General",
      label: r.pinnedFavorites.label,
      description: r.pinnedFavorites.description,
      values: ON_OFF(r.pinnedFavorites.on, r.pinnedFavorites.off),
    },
    {
      key: "rememberPositions",
      group: "General",
      label: r.rememberPositions.label,
      description: r.rememberPositions.description,
      values: ON_OFF(r.rememberPositions.on, r.rememberPositions.off),
      notes: [(c) => r.rememberPositions.stored(tilde(positionsFile(c.cwd))), r.rememberPositions.atStart],
    },
    {
      key: "rememberView",
      group: "General",
      label: r.rememberView.label,
      description: r.rememberView.description,
      values: ON_OFF(r.rememberView.on, r.rememberView.off),
      notes: [(c) => r.rememberView.stored(tilde(sessionViewsFile(c.cwd)))],
    },
    {
      key: "mouse",
      group: "General",
      label: r.mouse.label,
      description: (c) => r.mouse.description(c.terminal === "wt" ? r.mouse.selectWt : c.terminal === "tmux" ? r.mouse.selectTmux : r.mouse.selectOther),
      values: ON_OFF(r.mouse.on, (c) => (c.terminal === "tmux" ? r.mouse.offTmux : r.mouse.off)),
    },
    {
      key: "filterIn",
      group: "General",
      label: r.filterIn.label,
      description: r.filterIn.description,
      values: meanings(FILTER_IN_VALUES, r.filterIn),
    },
    {
      key: "updateMode",
      group: "General",
      label: r.updateMode.label,
      description: r.updateMode.description,
      values: meanings(UPDATE_VALUES, r.updateMode),
      notes: r.updateMode.notes,
    },
    {
      key: "accountColor",
      group: "Account",
      label: r.accountColor.label,
      description: r.accountColor.description,
      values: [
        ["auto", r.accountColor.auto],
        ["off", r.accountColor.off],
        ...ACCOUNT_COLOR_NAMES.map((name): [string, string] => [name, ""]),
      ],
      look: (value) => (ACCOUNT_COLOR_NAMES.includes(value as AccountColorName) ? colorBadge(value as AccountColorName) : undefined),
    },
    {
      key: "accountAvatar",
      group: "Account",
      label: r.accountAvatar.label,
      description: r.accountAvatar.description,
      values: [["", r.accountAvatar.none], ...ALL_AVATAR_PRESETS.map((p): [string, string] => [p.avatar, p.meaning])],
      dialog: "avatar",
      inline: true,
      notes: [() => r.accountAvatar.emojis(emojiInputHint())],
    },
    {
      key: "accountTitle",
      group: "Account",
      label: r.accountTitle.label,
      description: r.accountTitle.description,
      values: ON_OFF(r.accountTitle.on, r.accountTitle.off),
    },
    {
      key: "viewAccounts",
      group: "Account",
      label: r.viewAccounts.label,
      description: r.viewAccounts.description,
      values: ON_OFF(r.viewAccounts.on, r.viewAccounts.off),
    },
    listWidthRow("accountsListWidth", "Account", r.accountsListWidth.label, r.accountsListWidth.suits),
    {
      key: "accountsOrder",
      group: "Account",
      label: r.accountsOrder.label,
      description: r.accountsOrder.description,
      values: meanings(ACCOUNTS_ORDER_VALUES, r.accountsOrder),
      viewKey: m.inView("`s`", L().tabs.accounts),
    },
    viewTab("viewChat", "Chat", "1", r.viewChat.what),
    listWidthRow("chatListWidth", "Chat", t.listWidth, r.chatListWidth.suits),
    {
      key: "showTools",
      group: "Chat",
      label: r.showTools.label,
      description: r.showTools.description,
      values: meanings(TOOL_LEVELS, r.showTools),
      viewKey: m.inView("`t`", groupName("Chat")),
    },
    {
      key: "showThinking",
      group: "Chat",
      label: r.showThinking.label,
      description: r.showThinking.description,
      values: ON_OFF(r.showThinking.on, r.showThinking.off),
      viewKey: m.inView("`h`", groupName("Chat")),
    },
    {
      key: "showAgents",
      group: "Chat",
      label: r.showAgents.label,
      description: r.showAgents.description,
      values: ON_OFF(r.showAgents.on, r.showAgents.off),
    },
    wrapRow("chatWrap", "Chat", r.chatWrap.what, r.chatWrap.off),
    listOrder("chatOrder", "Chat", r.chatOrder.what),
    viewTab("viewGit", "Changes", "2", r.viewGit.what),
    listWidthRow("gitListWidth", "Changes", t.listWidth, r.gitListWidth.suits),
    wrapRow("wrap", "Changes", r.wrap.what, r.wrap.off),
    {
      key: "gitNestedRepos",
      group: "Changes",
      label: r.gitNestedRepos.label,
      description: r.gitNestedRepos.description,
      values: ON_OFF(r.gitNestedRepos.on, r.gitNestedRepos.off),
    },
    viewTab("viewPlan", "Plan", "3", r.viewPlan.what),
    listWidthRow("planListWidth", "Plan", t.listWidth, r.planListWidth.suits),
    wrapRow("planWrap", "Plan", r.planWrap.what, r.planWrap.off),
    listOrder("planOrder", "Plan", r.planOrder.what),
    { ...viewTab("viewSessions", "Sessions", "4", r.viewSessions.what), legend: true },
    listWidthRow("sessionsListWidth", "Sessions", t.listWidth, r.sessionsListWidth.suits),
    {
      key: "sessionsFolders",
      group: "Sessions",
      label: r.sessionsFolders.label,
      description: r.sessionsFolders.description,
      values: [
        ["this", (c) => r.sessionsFolders.this(basename(c.cwd) || c.cwd)],
        ["other", (c) => r.sessionsFolders.other(basename(c.cwd) || c.cwd)],
        ["all", r.sessionsFolders.all],
      ],
      dialog: "sessions",
      legend: true,
      viewKey: m.inView("`a`", groupName("Sessions")),
    },
    {
      key: "sessionsAccounts",
      group: "Sessions",
      label: r.sessionsAccounts.label,
      description: r.sessionsAccounts.description,
      values: [
        ["current", r.sessionsAccounts.current],
        ["all", r.sessionsAccounts.all],
      ],
      ownName: (value) => m.chosen(value.split(ACCOUNT_DIRS_SEPARATOR).length),
      ownMeaning: (value) => value.split(ACCOUNT_DIRS_SEPARATOR).map(tilde).join(", "),
      dialog: "sessions",
      legend: true,
      viewKey: m.inView("`a`", groupName("Sessions")),
    },
    {
      key: "sessionsBackground",
      group: "Sessions",
      label: r.sessionsBackground.label,
      description: r.sessionsBackground.description,
      values: meanings(SESSIONS_BACKGROUND_VALUES, r.sessionsBackground),
      dialog: "sessions",
      legend: true,
      inline: true,
      viewKey: m.inView("`a`", groupName("Sessions")),
    },
    {
      key: "sessionsRemote",
      group: "Sessions",
      label: r.sessionsRemote.label,
      description: r.sessionsRemote.description,
      values: meanings(SESSIONS_REMOTE_VALUES, r.sessionsRemote),
      dialog: "sessions",
      legend: true,
      inline: true,
      viewKey: m.inView("`a`", groupName("Sessions")),
    },
    {
      key: "remoteApi",
      group: "Sessions",
      label: r.remoteApi.label,
      description: r.remoteApi.description,
      values: ON_OFF(r.remoteApi.on, r.remoteApi.off),
    },
    {
      key: "remoteControl",
      group: "Sessions",
      label: r.remoteControl.label,
      description: r.remoteControl.description,
      values: ON_OFF(r.remoteControl.on, r.remoteControl.off),
    },
    {
      key: "pinnedSessions",
      group: "Sessions",
      label: r.pinnedSessions.label,
      description: r.pinnedSessions.description,
      values: ON_OFF(r.pinnedSessions.on, r.pinnedSessions.off),
    },
    listRange("sessionsRange", "Sessions", r.sessionsRange.what, r.sessionsRange.dated),
    viewTab("viewMonitor", "Monitor", "5", r.viewMonitor.what),
    listWidthRow("monitorListWidth", "Monitor", t.listWidth, r.monitorListWidth.suits),
    { ...listRange("monitorRange", "Monitor", r.monitorRange.what, r.monitorRange.dated), notes: [r.monitorRange.note] },
    listWidthRow("settingsListWidth", "Settings", t.listWidth, r.settingsListWidth.suits),
  ];
}

/** A value as the details name it: on/off, the range's days, the avatar's stand-in, in the current language. */
const valueName = (v: string | boolean, key?: keyof Settings): string => {
  const names = L().settings.values;
  if (v === "all" && (key === "sessionsRange" || key === "monitorRange")) return names.unlimited;
  if (typeof v === "boolean") return v ? names.on : names.off;
  if (v === "") return DEFAULT_AVATAR;
  if (v in LANGUAGE_NAMES) return LANGUAGE_NAMES[v as Language];
  return names[v] ?? v;
};

/** A value as the list shows it: the order values without "-first", so the labels keep their room. */
export const shortValueName = (v: string | boolean, key?: keyof Settings) =>
  v === "newest-first" ? L().settings.values.newest : v === "oldest-first" ? L().settings.values.oldest : valueName(v, key);

/** A row's value as the list shows it; one of one's own by the row's `ownName`. */
const rowValueName = (row: Row, v: string | boolean) =>
  typeof v === "string" && row.ownName && !row.values.some(([value]) => value === v) ? row.ownName(v) : shortValueName(v, row.key);

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

export function tilde(path: string): string {
  const home = homedir();
  return path.toLowerCase().startsWith(home.toLowerCase()) ? "~" + path.slice(home.length) : path;
}

/** Detail lines of a setting: its values (current one marked, default named), the view key and notes. */
/** The preview of a reset action: what it does, and what it would change or delete right now. */
function resetLines(action: ResetAction, changed: string[], marked: number, saved: { name: string; path: string }[], width: number): string[] {
  const wrap = (text: string, indent = "") => wrapText(text, width, indent);
  const t = L().settings.reset;
  const lines = [...wrap(action.description), ""];
  if (action.id === "settings") {
    lines.push(bold(t.changed));
    if (changed.length === 0) lines.push(dim(t.noneChanged));
    for (const name of changed) lines.push(...wrap(name, "  "));
    if (marked > 0) lines.push("", bold(t.marked), `  ${marked} ★`);
  } else {
    lines.push(bold(t.saved));
    if (saved.length === 0) lines.push(dim(t.nothingSaved));
    for (const d of saved) lines.push(...wrap(d.name, "  "), ...wrap(dim(tilde(d.path)), "    "));
  }
  lines.push("", dim(codeMarks(t.asksFirst)));
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
  return { title: L().settings.doctor.title, status: "running", text: L().settings.doctor.checking, step: { label: checking.current, at: at + 1, of: DOCTOR_GROUPS.length } };
}

/** The doctor's details: what it does, the repair while it runs, then the report of the last check (the dialog shows a check under way). */
function doctorLines(action: ResetAction, check: DoctorCheck | undefined, checking: DoctorChecking | undefined, run: DoctorRun | undefined, width: number): string[] {
  const wrap = (text: string, indent = "") => wrapText(text, width, indent);
  const t = L().settings.doctor;
  const lines = [...wrap(action.description)];
  if (run) {
    lines.push("", bold(t.repairHeading));
    for (const r of run.results) {
      const mark = r.status === "done" ? GREEN("✓") : r.status === "failed" ? RED("✗") : r.status === "running" ? YELLOW("●") : dim("○");
      lines.push(...wrap(`${mark} ${r.step.command ?? r.step.label}`, "  "));
      if (r.status === "running" || r.status === "failed") for (const l of outputTail(r.output, 12)) lines.push(...wrapText(dim(l), width, "      ", false));
    }
    if (run.status === "running") lines.push("", dim(t.repairing));
  }
  if (checking) return lines;
  if (!check) return [...lines, "", dim(codeMarks(t.notChecked))];
  lines.push(...wrapIndented(reportLines(check.findings, true), width), "");
  const repairable = countFindings(check.findings).repairable;
  lines.push(dim(codeMarks(repairable > 0 ? t.repairOffer(repairable) : t.nothingToRepair)));
  return lines;
}

export function settingLines(row: Row, current: string | boolean, width: number, context: TextContext): string[] {
  const wrap = (text: string, indent = "") => wrapText(text, width, indent);
  const m = L().settings;
  const lines = [...wrap(textOf(row.description, context)), ""];
  lines.push(bold(m.valuesHeading));
  // A text of one's own (the avatar) is none of the values on offer.
  const own = typeof current === "string" && !row.values.some(([v]) => v === current);
  if (row.inline) {
    // One line each, the meaning after the value, the meanings in a column.
    const entries: [string, string, boolean][] = [
      ...(own ? [[row.ownName?.(current as string) ?? (current as string), row.ownMeaning?.(current as string) ?? m.yourOwn, true] as [string, string, boolean]] : []),
      ...row.values.map(([value, meaning]): [string, string, boolean] => [
        valueName(value, row.key) + (value === DEFAULT_SETTINGS[row.key] ? ` (${m.default})` : ""),
        textOf(meaning, context),
        value === current,
      ]),
    ];
    const column = Math.max(...entries.map(([name]) => stringWidth(name)));
    lines.push("");
    for (const [name, meaning, selected] of entries) {
      const padded = name + " ".repeat(column - stringWidth(name));
      lines.push(selected ? `\u001b[32m● ${padded}\u001b[39m  ${meaning}` : `${dim("○")} \u001b[90m${padded}\u001b[39m  ${dim(meaning)}`);
    }
  } else if (own) lines.push("", `\u001b[32m● ${row.ownName?.(current as string) ?? current}\u001b[39m`, ...wrap(row.ownMeaning?.(current as string) ?? m.yourOwn, "  "));
  let compact = false;
  for (const [value, meaning] of row.inline ? [] : row.values) {
    const selected = value === current;
    const look = typeof value === "string" ? row.look?.(value) : undefined;
    if (look) {
      // Drawn as it looks, one per line, below the last value with a meaning.
      if (!compact) lines.push("");
      compact = true;
      lines.push(`${selected ? GREEN("●") : dim("○")} ${look}`);
      continue;
    }
    compact = false;
    // A blank line below the heading and between the values: most take two or three lines with their example.
    lines.push("");
    const name = valueName(value, row.key) + (value === DEFAULT_SETTINGS[row.key] ? ` (${m.default})` : "");
    // The value on a line of its own, what it does indented below it.
    // Names in colour, so they stand out from their descriptions: the current one green, the others gray.
    lines.push(selected ? `\u001b[32m● ${name}\u001b[39m` : `${dim("○")} \u001b[90m${name}\u001b[39m`, ...wrap(textOf(meaning, context), "  "));
  }
  if (row.viewKey) lines.push("", dim(codeMarks(m.also(row.viewKey))));
  for (const note of (row.notes ?? []).map((n) => textOf(n, context)).filter(Boolean)) lines.push("", ...wrap(dim(note)));
  if (row.legend) {
    // The marks in a column, what each says wrapped beside it.
    const column = Math.max(...SESSION_LEGEND.map((m) => stringWidth(m.mark)));
    lines.push("", bold(m.legendHeading));
    for (const m of SESSION_LEGEND) {
      // Without a mark (the project's name): the name in its colour on a line of its own, what it says below.
      if (!m.mark) {
        lines.push(`  ${legendMark({ ...m, mark: m.short })}`, ...wrapText(m.text, width, " ".repeat(column + 4)));
        continue;
      }
      const [first = "", ...rest] = wrapText(m.text, width - column - 4);
      const pad = " ".repeat(column - stringWidth(m.mark));
      lines.push(`  ${legendMark(m)}${pad}  ${first}`, ...rest.map((l) => " ".repeat(column + 4) + l));
    }
  }
  return lines;
}

/** A colour's name drawn like the "cco" in the top bar: on the colour, in the text colour readable on it. */
export function colorBadge(name: AccountColorName): string {
  const index = ACCOUNT_COLOR_NAMES.indexOf(name);
  const background = index < 8 ? 40 + index : 100 + index - 8;
  const text = ACCOUNT_COLORS[name] === "black" ? 30 : 97;
  return `\u001b[${background};${text}m ${name} \u001b[39;49m`;
}

/** An avatar drawn on the account's colour, as in the top bar. */
export function avatarBadge(avatar: string, name: AccountColorName): string {
  const index = ACCOUNT_COLOR_NAMES.indexOf(name);
  const background = index < 8 ? 40 + index : 100 + index - 8;
  const text = ACCOUNT_COLORS[name] === "black" ? 30 : 97;
  return `\u001b[${background};${text}m ${avatar} \u001b[39;49m`;
}

/** The colour name of `account` as this viewer shows it. */
const colorNameOf = (account: Account, state: AccountState, chosen: Settings["accountColor"]): AccountColorName => colorOfAccount(account, state, chosen);

/** The label of an Account entry in the list. */
function accountLabel(e: AccountEntry, state: AccountState): string {
  const t = L().settings.account;
  if (!("dir" in e)) return e.account === "details" ? t.details : e.account === "add" ? t.add : t.none;
  const account = state.accounts.find((a) => a.dir === e.dir);
  // The active account is marked; the folder tells accounts with the same email apart.
  return `${e.dir === state.current?.dir ? "● " : "○ "}${account?.email ?? e.dir} (${basename(e.dir)})`;
}

/** The account an Account entry shows, if it is one. */
const accountOf = (e: AccountEntry, state: AccountState): Account | undefined =>
  "dir" in e ? state.accounts.find((a) => a.dir === e.dir) : undefined;

/** The preview of an Account entry: the account's data, or how the accounts were looked for. */
export function accountLines(e: AccountEntry, state: AccountState, settings: Settings, width: number): string[] {
  const wrap = (text: string, indent = "") => wrapText(text, width, indent);
  const field = (name: string, value: string | undefined) => (value ? wrap(`${name}: ${value}`) : []);
  const t = L().settings.account;
  if (e.account === "add") return addAccountLines(width);
  if (e.account === "details") {
    const searched = state.accounts.map((a) => `${tilde(a.dir)}  ${a.email}`);
    return [
      ...wrap(t.howFound),
      "",
      bold(t.thisViewer),
      ...field("CLAUDE_CONFIG_DIR", process.env.CLAUDE_CONFIG_DIR ? tilde(process.env.CLAUDE_CONFIG_DIR) : t.notSet),
      ...field(t.configFolder, tilde(state.own)),
      ...field(t.ccoFiles, tilde(join(state.own, "cco"))),
      "",
      bold(t.accountsFound(state.accounts.length)),
      ...(searched.length > 0 ? searched.flatMap((l) => wrap(l, "  ")) : wrap(t.noneFound, "  ")),
      "",
      ...wrap(dim(t.lookedUp)),
    ];
  }
  const account = accountOf(e, state);
  if (!account) {
    return wrap(t.noAccount);
  }
  const color = colorNameOf(account, state, settings.accountColor);
  const fixed = hasChosenColor(account, state, settings.accountColor);
  const avatar = avatarOfAccount(account, state, settings.accountAvatar);
  return [
    state.current?.dir === account.dir ? GREEN(t.active) : dim(t.another),
    "",
    ...field(t.email, account.email),
    ...field(t.name, account.name),
    ...field(t.organization, [account.organization, account.organizationType && `(${account.organizationType})`].filter(Boolean).join(" ")),
    ...field(t.billing, account.billing),
    ...field(t.seat, account.seat),
    ...field(t.rateLimitTier, account.rateLimitTier),
    "",
    ...field(t.configFolder, tilde(account.dir)),
    ...field(t.readFrom, tilde(account.file)),
    t.colour(colorBadge(color), fixed),
    `${t.avatar}: ${avatar ? avatarBadge(avatar, color) : dim(t.noAvatar(DEFAULT_AVATAR))}`,
    "",
    ...wrap(dim(t.showsWhere)),
  ];
}

/**
 * The preview of "how to add an account": what an account is to Claude Code, what `Enter` sets up, how to do it by
 * hand on Windows and elsewhere, and the names a start script must not have.
 */
export function addAccountLines(width: number, platform: NodeJS.Platform = process.platform): string[] {
  const wrap = (text: string, indent = "") => wrapText(text, width, indent);
  const code = (lines: string[]) => lines.map((l) => `    ${codeMarks(`\`${l}\``)}`);
  const bin = tilde(claudeBinDir().dir);
  const windows = platform === "win32";
  const t = L().settings.addAccount;
  return [
    ...wrap(t.intro),
    "",
    bold(t.enterHeading),
    ...wrap(t.asks, "  "),
    ...wrap(t.step1, "  "),
    ...wrap(t.step2(bin, windows), "  "),
    ...wrap(t.step3, "  "),
    ...wrap(t.step4, "  "),
    "",
    bold(t.byHand),
    ...(windows
      ? [
          ...wrap(t.cmdFile, "  "),
          ...code(["@echo off", "setlocal", 'set "CLAUDE_CONFIG_DIR=%USERPROFILE%\\.claude-cw"', "call claude %*"]),
          ...wrap(t.bashFile, "  "),
          ...code(["#!/usr/bin/env bash", 'export CLAUDE_CONFIG_DIR="$USERPROFILE\\.claude-cw"', 'exec claude "$@"']),
        ]
      : [
          ...wrap(t.unixFile, "  "),
          ...code(["#!/usr/bin/env bash", 'export CLAUDE_CONFIG_DIR="$HOME/.claude-cw"', 'exec claude "$@"']),
        ]),
    ...wrap(t.thenRun, "  "),
    ...code([`cw plugin marketplace add ${marketplaceSource()}`, "cw plugin install cco@cc-outline"]),
    "",
    bold(t.avoid),
    ...wrap(windows ? t.avoidWindows : t.avoidUnix),
  ];
}

/** The entries of the Releases group: the update on offer, then each release, or a note while there are none. */
type ReleaseEntry = { kind: "update" } | { kind: "release"; release: Release } | { kind: "releases" };
/** The info entries of the Account group: one per account found (the active one marked), a note while there is none, and how they were found. */
export type AccountEntry = { account: "none" | "details" | "add" } | { account: "item"; dir: string };
type Entry = Row | ReleaseEntry | ResetAction | AccountEntry;

/** The group an entry is listed under. */
const groupOf = (e: Entry): string => groupName("key" in e ? e.group : "account" in e ? "Account" : "id" in e ? "Reset" : "Releases");

const keyOf = (e: Entry): string =>
  "key" in e ? e.key : "account" in e ? ("dir" in e ? `account:${e.dir}` : `account:${e.account}`) : "id" in e ? `reset:${e.id}` : e.kind === "release" ? `release:${e.release.tag}` : e.kind;

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

/** The update's progress dialog: the step running, then the restart, or where it stopped. */
export function updateProgress(run: UpdateRun, copy?: () => void, onClose?: () => void): Progress {
  const steps: ProgressStep[] = run.steps.map((s) => ({ label: L().steps.names[s.step.label] ?? s.step.label, status: s.status, output: s.output }));
  const t = L().settings.update;
  const title = t.title(run.target);
  if (run.status === "running") return { title, status: "running", text: t.updating, step: currentStep(steps) };
  if (run.status === "failed")
    return {
      title,
      status: "failed",
      text: t.stoppedAt(stepText(currentStep(steps)) ?? ""),
      lines: [...failureLines(steps), t.runRest],
      copy,
      onClose,
    };
  if (run.reopenFailed)
    return {
      title,
      status: "done",
      text: t.updatedTo(run.target),
      lines: [REOPEN_BY_HAND(), t.restartForPlugin],
      onClose,
    };
  return { title, status: "waiting", text: t.restarting, detail: t.updatedTo(run.target) };
}

/** The commands of the repairs that failed, to run by hand. */
export function failedRepairCommands(run: DoctorRun): string[] {
  return run.results.flatMap((r) => (r.status === "failed" && r.step.command ? [r.step.command] : []));
}

/** The repair's progress dialog: the step running, or the steps that failed (c copies their commands, if any). */
export function repairProgress(run: DoctorRun, copy?: () => void, onClose?: () => void): Progress {
  const steps: ProgressStep[] = run.results.map((r) => ({ label: r.step.label, status: r.status, output: r.output }));
  const t = L().settings.doctor;
  const title = t.repairTitle;
  if (run.status === "failed") {
    const failed = steps.filter((s) => s.status === "failed").length;
    return {
      title,
      status: "failed",
      text: t.repairFailed(failed, steps.length),
      lines: [...failureLines(steps), t.reportShows],
      copy: failedRepairCommands(run).length > 0 ? copy : undefined,
      onClose,
    };
  }
  return { title, status: "running", text: t.repairing.replace("…", ""), step: currentStep(steps) };
}

/** The update entry's details: what Enter does, the steps while they run, then the notes of the newer releases. */
function updateLines(update: Update, width: number): string[] {
  const wrap = (text: string, indent = "") => wrapText(text, width, indent);
  const { state, run } = update;
  const t = L().settings.update;
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
      lines.push(...wrap(t.stopped), ...remainingCommands(run.steps).map((c) => `  ${codeSpan(c)}`));
    else if (run.status === "done")
      lines.push(...wrap(t.done(run.target)));
    else lines.push(dim(t.updatingNow));
  } else if (state.kind === "update") {
    lines.push(
      ...wrap(t.isOut(state.target, VERSION)),
      ...commands,
      "",
      ...wrap(dim(t.thenReopens)),
    );
  } else if (state.kind === "restart") {
    lines.push(...wrap(t.installed(state.target, VERSION)));
  } else if (state.kind === "dev") {
    lines.push(
      ...wrap(t.dev(state.target, VERSION, tilde(update.root))),
      ...commands,
    );
  }
  for (const r of newerReleases(update)) lines.push("", rule(width, `v${r.version}`), "", ...releaseLines(r, width));
  return lines;
}

function releaseLines(release: Release, width: number): string[] {
  return release.body.trim() ? renderMarkdown(release.body, width) : [dim(L().settings.update.noNotes)];
}

/** The details while no release notes are known. */
function releasesNote(update: Update, width: number): string[] {
  const t = L().settings.update;
  const text = update.checking ? t.asking : update.mode === "off" && update.checkedAt === undefined ? t.checkOff : t.unreachable;
  return wrapText(text, width);
}

/** What a restart runs: the version on disk, which differs from the running one after an update. */
export function restartDetail(root: string): string {
  const installed = root ? installedVersion(root) : undefined;
  return installed && installed !== VERSION ? L().settings.restart.running(installed, VERSION) : `v${installed ?? VERSION}`;
}

/** The list: the settings, the reset actions, then the releases (the last group, since it grows). */
export function settingsEntries(update: Update, accounts: AccountState = { accounts: [], multiple: false, own: "" }): Entry[] {
  // The Account group sits after General: its info entries come before its settings.
  const rows = settingRows();
  const first = rows.findIndex((r) => r.group === "Account");
  const last = first + rows.filter((r) => r.group === "Account").length - 1;
  const items: AccountEntry[] = accounts.accounts.length > 0 ? accounts.accounts.map((a): AccountEntry => ({ account: "item", dir: a.dir })) : [{ account: "none" }];
  return [
    ...rows.slice(0, first),
    ...items,
    ...rows.slice(first, last + 1),
    { account: "details" },
    { account: "add" },
    ...rows.slice(last + 1),
    ...resetActions(),
    ...releaseEntries(update),
  ];
}

export function SettingsView({ layout, active, onModal, onTyping, cwd, onResetData, onRestart, select: asked, sessionPath, noSession, claudePid }: Props) {
  // Enter on an account: continue the session there, start a new one, open its folder (as in the Accounts view).
  const [flash, setFlash] = useState<string>();
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(undefined), 3000);
    return () => clearTimeout(timer);
  }, [flash]);
  const flow = useAccountFlow({ layout, claudePid, notify: setFlash });
  const u = L().settings.update;
  const { listWidth, previewWidth, bodyHeight, headerHeight = bodyHeight, listHeight = bodyHeight } = layout;
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
  const [avatarOpen, setAvatarOpen] = useState(false);
  // The Sessions view's filter, opened from one of its three settings.
  const [sessionsFilterOpen, setSessionsFilterOpen] = useState(false);
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
  const accountState = useAccountState();
  const otherDirs = otherAccounts(accountState.accounts).map((a) => a.dir);
  const listEntries = settingsEntries(update, accountState);
  const entries = listEntries.map(keyOf);
  // Kept by key: the releases arrive after the start and move the entries below them.
  const [selectedKey, setSelectedKey] = useState(() => positions.selected);
  const index = entries.includes(selectedKey ?? "") ? entries.indexOf(selectedKey!) : resolveKey(selectedKey, listEntries);
  const entry = listEntries[index];
  const row = "key" in entry ? entry : undefined;
  const reset = "id" in entry ? entry : undefined;
  const release = "kind" in entry ? entry : undefined;
  const accountEntry = "account" in entry ? entry : undefined;
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
        ? { list: haystack([rowValueName(e, settings[e.key]), groupName(e.group), e.label]), details: plainMarks(textOf(e.description, context)) }
        : "account" in e
          ? { list: haystack([groupName("Account"), accountLabel(e, accountState)]), details: accountLines(e, accountState, settings, 80).join("\n") }
        : "id" in e
          ? { list: haystack([groupName("Reset"), e.label]), details: plainMarks(e.description) }
          : e.kind === "release"
            ? { list: haystack([groupName("Releases"), e.release.tag, e.release.title]), details: e.release.body }
            : { list: haystack([groupName("Releases"), entryLabel(e)]), details: "" },
    deps: [settings, update.releases, update.state, context, accountState],
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
  const modal = confirmation !== undefined || avatarOpen || sessionsFilterOpen || updating || doctorBusy || flow.open;
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

  const changed = settingRows().filter((r) => settings[r.key] !== DEFAULT_SETTINGS[r.key]);
  const canReset = changed.length > 0 || marked > 0;
  const saved = useMemo(() => (reset?.id === "data" ? projectData(cwd) : []), [reset?.id, cwd, confirmation]);
  const findings = doctorCheck?.findings ?? [];
  const repairs = repairsOf(findings);
  const newer = newerReleases(update);
  const asOf = update.stale && update.checkedAt ? u.asOf(day(new Date(update.checkedAt).toISOString())!) : undefined;

  function entryLabel(e: ReleaseEntry): string {
    if (e.kind === "release") return u.entryRelease(e.release.version, e.release.title !== e.release.tag ? ` ${e.release.title}` : "");
    if (e.kind === "releases") return update.checking ? u.checkingEntry : u.releaseNotes;
    const { state, run } = update;
    if (run) return u.updateTo(run.target);
    if (state.kind === "restart") return u.restartWith(state.target);
    if (state.kind === "dev") return u.out(state.target);
    return state.kind === "update" ? u.updateTo(state.target) : u.update;
  }

  function releaseHeader(e: ReleaseEntry): string[] {
    if (e.kind === "release") {
      const r = e.release;
      const cmp = compareVersions(r.version, VERSION);
      const details = [[day(r.date), cmp === 0 ? u.installedMark : cmp > 0 ? u.newMark : undefined, asOf].filter(Boolean).join(" · ")];
      return previewHeader(entryLabel(e), previewWidth, { marker: "◆ ", style: bold, details: r.url ? [...details, r.url] : details });
    }
    if (e.kind === "releases") return previewHeader(u.releasesHeader, previewWidth, { marker: "◆ ", style: bold, details: [u.updateMode(shortValueName(update.mode))] });
    const detail = update.install === "dev" ? u.devInstall(VERSION) : u.installedVersion(VERSION);
    const title = entryLabel(e);
    return previewHeader(title[0].toUpperCase() + title.slice(1), previewWidth, {
      marker: "↑ ",
      style: bold,
      details: [[detail, newer.length > 0 ? u.newer(newer.length) : undefined, asOf].filter(Boolean).join(" · ")],
    });
  }

  const header = useMemo(
    () =>
      fitHeader(
        reset
          ? previewHeader(reset.id === "doctor" ? L().settings.doctor.title : L().settings.reset.header(reset.label), previewWidth, {
              marker: reset.id === "doctor" ? "✚ " : "↺ ",
              style: bold,
              details: [
                reset.id === "doctor"
                  ? doctorChecking
                    ? L().settings.doctor.checkingHeader
                    : doctorCheck
                      ? L().settings.doctor.checkedAt(countText(findings), new Date(doctorCheck.at).toTimeString().slice(0, 5))
                      : L().settings.doctor.notCheckedHeader
                  : reset.id === "settings"
                    ? L().settings.reset.changedCount(changed.length) + (marked > 0 ? ` · ${L().settings.reset.markedCount(marked)}` : "")
                    : reset.id === "data"
                      ? L().settings.reset.savedFiles(saved.length)
                      : restartDetail(update.root),
              ],
            })
          : accountEntry
            ? previewHeader(L().settings.account.header(accountLabel(accountEntry, accountState)), previewWidth, {
                marker: "◉ ",
                style: bold,
                details: [L().settings.account.found(accountState.accounts.length)],
              })
          : release
            ? releaseHeader(release)
            : previewHeader(`${groupName(row!.group)}: ${row!.label}`, previewWidth, {
                marker: "⚙ ",
                style: bold,
                details: [L().settings.view.settingHeader(valueName(current!, row!.key), valueName(DEFAULT_SETTINGS[row!.key], row!.key))],
              }),
        headerHeight,
      ),
    [entry, update, current, changed.length, marked, saved.length, doctorCheck, doctorChecking, previewWidth, headerHeight, accountState],
  );
  const lines = useMemo(
    () =>
      reset
        ? reset.id === "doctor"
          ? doctorLines(reset, doctorCheck, doctorChecking, doctorRun, previewWidth)
          : resetLines(reset, changed.map((r) => `${groupName(r.group)} ${r.label}`), marked, saved, previewWidth)
        : accountEntry
          ? accountLines(accountEntry, accountState, settings, previewWidth)
        : release
          ? release.kind === "update"
            ? updateLines(update, previewWidth)
            : release.kind === "release"
              ? releaseLines(release.release, previewWidth)
              : releasesNote(update, previewWidth)
          : settingLines(row!, current!, previewWidth, context),
    [entry, update, current, changed.length, marked, saved, doctorCheck, doctorChecking, doctorRun, previewWidth, context, accountState],
  );
  const viewport = bodyHeightBelow(header, bodyHeight);
  const scroll = positions.scroll(entryKey, lines.length, viewport);

  const set = (changes: Partial<Settings>) => updateSettings(changes);
  const select = (i: number) => setSelectedKey(entries[Math.max(0, Math.min(entries.length - 1, i))]);
  const askResetSettings = () =>
    setConfirmation({
      title: L().settings.reset.askSettingsTitle,
      lines: [
        ...(changed.length > 0
          ? [L().settings.reset.differ(changed.length, settingRows().length), changed.map((r) => `${groupName(r.group)} ${r.label}`).join(", ")]
          : [L().settings.reset.allDefault]),
        ...(marked > 0 ? [L().settings.reset.marksRemoved(marked)] : []),
      ],
      onConfirm: () => {
        set({ ...DEFAULT_SETTINGS });
        favorites.clear();
      },
    });
  const askResetData = () =>
    setConfirmation({
      title: L().settings.reset.askDataTitle,
      lines: [...saved.map((d) => `· ${d.name}`), L().settings.reset.dataStays],
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
      title: L().settings.doctor.askTitle,
      lines: L().settings.doctor.askLines,
      onConfirm: () => void runCheck(),
    });
  const askRepair = () =>
    setConfirmation({
      title: L().settings.doctor.askRepair(countFindings(findings).repairable),
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
      title: L().settings.restart.askTitle,
      lines: [L().settings.restart.opensAgain(restartDetail(update.root)), L().settings.restart.keepsRunning],
      onConfirm: () => onRestart?.(),
    });
  // Like q: with confirm quit off, no question. The app shows the restart's progress.
  const restart = () => (settings.confirmQuit ? askRestart() : onRestart?.());
  const { state } = update;
  const canUpdate = state.kind === "update" && !updating && update.run?.status !== "done";
  const askUpdate = () =>
    state.kind === "update" &&
    setConfirmation({
      title: L().settings.update.askTitle(state.target),
      lines: [...UPDATE_STEPS.map((s) => s.command), L().settings.update.thenReopensShort],
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
    if (accountEntry?.account === "add") return flow.askAddAccount(cwd);
    if (accountEntry && "dir" in accountEntry) {
      const account = accountState.accounts.find((a) => a.dir === accountEntry.dir);
      return account && flow.accountMenu(account, cwd, sessionPath ? ownSession(sessionPath, cwd) : undefined, noSession);
    }
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
    if (row?.dialog === "avatar") return setAvatarOpen(true);
    if (row?.dialog === "sessions") return setSessionsFilterOpen(true);
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
      if (key.return && (reset || onUpdate || row || accountEntry)) return activate();
      // d moves an account to the trash (the Accounts view keeps it), u brings back the one moved last.
      if (input === "d" && accountEntry && "dir" in accountEntry) {
        const account = accountState.accounts.find((a) => a.dir === accountEntry.dir);
        return account && flow.askTrash(account);
      }
      if (input === "u" && flow.undoTrash()) return;
      if (onUpdate && input === "c") return copyCommands();
      if (input === "r" && row) return set({ [row.key]: DEFAULT_SETTINGS[row.key] });
      if (input === "R" && canReset) return askResetSettings();
      handleNavigation(input, key, { ...filter.nav, scroll, page: viewport - 2 });
    },
    { isActive: active && confirmation === undefined && !avatarOpen && !sessionsFilterOpen && !progressOpen && !filter.open && !flow.open },
  );

  /** What a row shows: the label, and at its right end the value (or mark); the group is the separator above it. */
  const rowParts = (e: Entry): { value: string; color?: string; background?: string; label: string } => {
    if ("key" in e) {
      const value = settings[e.key];
      return { value: rowValueName(e, value), color: value === DEFAULT_SETTINGS[e.key] ? undefined : "yellow", label: e.label };
    }
    if ("account" in e) {
      const account = accountOf(e, accountState);
      const color = account ? colorNameOf(account, accountState, settings.accountColor) : undefined;
      const avatar = account && avatarOfAccount(account, accountState, settings.accountAvatar);
      // A badge like the "cco" in the top bar, readable on any colour, also black on a black pane: the avatar, else the colour's name.
      return { value: color ? ` ${avatar ?? color} ` : "", color: color && ACCOUNT_COLORS[color], background: color, label: accountLabel(e, accountState) };
    }
    if ("id" in e) return { value: e.id === "doctor" ? "✚" : "↺", label: e.label };
    if (e.kind === "release") {
      const cmp = compareVersions(e.release.version, VERSION);
      return { value: cmp === 0 ? u.installedMark : cmp > 0 ? u.newMark : "", color: cmp === 0 ? "green" : "yellow", label: entryLabel(e) };
    }
    if (e.kind === "update") return { value: state.kind === "restart" ? "↻" : "↑", color: "yellow", label: entryLabel(e) };
    return { value: "", label: entryLabel(e) };
  };

  const f = L().settings.view.footer;
  const entryFooter = reset
    ? reset.id === "doctor"
      ? repairs.length > 0
        ? [
            { text: f.repair, priority: 4 },
            { text: f.check, priority: 3 },
          ]
        : [{ text: f.checkNow, priority: 4 }]
      : [{ text: f.reset, priority: 4 }]
    : onUpdate
      ? [
          ...(canUpdate ? [{ text: f.update, priority: 4 }] : state.kind === "restart" ? [{ text: f.restart, priority: 4 }] : []),
          { text: f.copyCommands, priority: 3 },
        ]
      : accountEntry
        ? [
            ...("dir" in accountEntry
              ? [
                  { text: f.actions, priority: 4 },
                  { text: f.delete, priority: 2 },
                ]
              : accountEntry.account === "add"
                ? [{ text: f.addAccount, priority: 4 }]
                : []),
            { text: f.reload, priority: 2 },
          ]
        : release
        ? [{ text: f.check, priority: 2 }]
        : [
            { text: row?.dialog ? f.choose : f.change, priority: 4 },
            { text: f.default, priority: 3 },
          ];
  return (
    <>
      <Screen
        layout={layout}
        mode="settings"
        status={
          <Text dimColor={!focused}>
            {/* The filter's count first: the path can be long. */}
            {filter.shown && L().settings.view.entries(filter.count(listEntries.length))}
            {copied && <Text color="green">{L().settings.view.copied}</Text>}
            {tilde(settingsFile())}
            {changed.length > 0 && <Text color="yellow">{L().settings.view.changed(changed.length)}</Text>}
            {update.checking && L().settings.view.checkingUpdates}
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
            height={listHeight}
            empty={filter.empty ?? L().settings.view.empty}
            itemKey={keyOf}
            group={groupOf}
            render={(e, isSelected) => {
              const star = favorites.isMarked(keyOf(e));
              const { value, color, background, label } = rowParts(e);
              // The value keeps its place at the right end; a label too long for the rest is cut (or scrolls).
              const labelWidth = Math.max(4, listWidth - (star ? 2 : 0) - (value ? stringWidth(value) + 1 : 0));
              const pad = Math.max(0, labelWidth - stringWidth(label));
              return (
                <>
                  {star && <Star />}
                  <EntryText text={label} width={labelWidth} selected={isSelected} active={active && !modal} />
                  {value && (
                    <Text>
                      {" ".repeat(pad + 1)}
                      <Text color={color} backgroundColor={background}>
                        {value}
                      </Text>
                    </Text>
                  )}
                </>
              );
            }}
          />
        }
        preview={
          filter.none ? (
            <Text dimColor>{L().settings.view.noMatch}</Text>
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
        footer={flash ?? [
          { text: f.setting, priority: 4 },
          ...entryFooter,
          ...markFooter(favorites.isMarked(entryKey), marked),
          ...filter.footer,
          ...(canReset ? [{ text: f.resetAll, priority: 2 }] : []),
          { text: f.views, priority: 1 },
        ]}
      />
      {confirmation && (
        <ConfirmDialog layout={layout} confirmation={confirmation} onClose={() => setConfirmation(undefined)} />
      )}
      {avatarOpen && (
        <AvatarDialog
          layout={layout}
          value={settings.accountAvatar}
          onSave={(avatar) => {
            set({ accountAvatar: avatar });
            setAvatarOpen(false);
          }}
          onCancel={() => setAvatarOpen(false)}
        />
      )}
      {sessionsFilterOpen && (
        <SessionFilterDialog
          layout={layout}
          initial={sessionFilter(settings, claudeDir(), otherDirs)}
          folderName={basename(cwd) || cwd}
          accounts={filterAccounts(accountState.accounts, claudeDir())}
          remote={settings.remoteApi}
          onApply={(next) => {
            set(filterSettings(next, claudeDir(), otherDirs));
            setSessionsFilterOpen(false);
          }}
          onClose={() => setSessionsFilterOpen(false)}
        />
      )}
      {flow.element}
      {filter.dialog}
    </>
  );
}
