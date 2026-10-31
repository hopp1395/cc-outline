import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_COLOR_VALUES, type AccountColorSetting } from "./account.js";
import { isAvatarSetting } from "./avatar.js";
import { claudeDir, readJson, writeJson } from "./transcript/locate.js";
import { TOOL_LEVELS, type ToolLevel } from "./transcript/tools.js";
import type { Mode } from "./tui/layout.js";

/** When the hook opens the viewer as Claude Code starts. */
export const AUTO_OPEN_VALUES = ["remember", "always", "never"] as const;
export type AutoOpen = (typeof AUTO_OPEN_VALUES)[number];

/** Order of a time-ordered list (Chat, Plan); Sessions and Monitor always show the newest first. */
export const ORDER_VALUES = ["oldest-first", "newest-first"] as const;
export type ListOrder = (typeof ORDER_VALUES)[number];

/** How far back the Sessions and Monitor lists reach at first; "load more" in the list reads the rest. */
export const RANGE_VALUES = ["today", "7d", "30d", "90d", "all"] as const;
export type ListRange = (typeof RANGE_VALUES)[number];

/** How the range values are shown. */
export const RANGE_NAMES: Record<ListRange, string> = {
  today: "today",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "unlimited",
};

/**
 * Local midnight of the first day `range` covers (today counts: "7d" is today
 * and the 6 days before), or undefined for "all".
 */
export function rangeStart(range: ListRange, now = new Date()): number | undefined {
  if (range === "all") return undefined;
  const days = range === "today" ? 1 : Number.parseInt(range, 10);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
}

/** The project folders whose sessions the Sessions view lists: this one's, the others', or all. */
export const SESSIONS_FOLDERS_VALUES = ["this", "other", "all"] as const;
export type SessionsFolders = (typeof SESSIONS_FOLDERS_VALUES)[number];
/** The Sessions view's background sessions (`claude -p`, the SDK, the daemon): listed with the others, alone, or left out. */
export const SESSIONS_BACKGROUND_VALUES = ["show", "hide"] as const;
export type SessionsBackground = (typeof SESSIONS_BACKGROUND_VALUES)[number];
/** The Sessions view's remote sessions (Remote Control sessions that run on another machine, from claude.ai): listed with the others, alone, or left out. */
export const SESSIONS_REMOTE_VALUES = ["show", "hide"] as const;
export type SessionsRemote = (typeof SESSIONS_REMOTE_VALUES)[number];
/** The accounts value naming the chosen config folders, joined by this. */
export const ACCOUNT_DIRS_SEPARATOR = "|";
/** A value of `sessionsAccounts`: `current`, `all`, or config folders joined by `|`. */
export const isAccountsSetting = (value: unknown): value is string =>
  typeof value === "string" && value.split(ACCOUNT_DIRS_SEPARATOR).every((dir) => dir.trim() !== "");
/** The former `sessionsScope`, which the filter's three settings replaced. */
const LEGACY_SCOPES: Record<string, { sessionsFolders: SessionsFolders; sessionsAccounts: string }> = {
  project: { sessionsFolders: "this", sessionsAccounts: "current" },
  all: { sessionsFolders: "all", sessionsAccounts: "current" },
  "project-accounts": { sessionsFolders: "this", sessionsAccounts: "all" },
  "all-accounts": { sessionsFolders: "all", sessionsAccounts: "all" },
};

/** The order of the other accounts in the Accounts view (s there), below the active one: by email, by folder name, or the one used last first. */
export const ACCOUNTS_ORDER_VALUES = ["email", "folder", "recent"] as const;
export type AccountsOrder = (typeof ACCOUNTS_ORDER_VALUES)[number];

/** What the list filter (Ctrl+F) looks at: the entries' rows, their details, or both. */
export const FILTER_IN_VALUES = ["list", "details", "both"] as const;
export type FilterIn = (typeof FILTER_IN_VALUES)[number];

/** The update check at the viewer's start: `on` asks npm and GitHub, `auto` also offers the update right away, `off` asks nothing. */
export const UPDATE_VALUES = ["on", "off", "auto"] as const;
export type UpdateMode = (typeof UPDATE_VALUES)[number];

/**
 * The compact view for small screens, with no help line and a shortened top bar: `single` shows one column (list or
 * preview), `stacked` the list above the preview, both as wide as the pane.
 */
export const COMPACT_VIEW_VALUES = ["off", "single", "stacked"] as const;
export type CompactView = (typeof COMPACT_VIEW_VALUES)[number];

/** How many columns the stacked list has (`<` and `>` change it), kept as text like the other choices. */
export const COMPACT_COLUMNS_VALUES = ["1", "2", "3", "4"] as const;
export type CompactColumns = (typeof COMPACT_COLUMNS_VALUES)[number];

/** The share of the pane's height the stacked list takes (the rows below the top bar). */
export const COMPACT_SPLIT_VALUES = ["10%", "20%", "30%", "40%", "50%"] as const;
export type CompactSplit = (typeof COMPACT_SPLIT_VALUES)[number];

/** Where the viewer opens: docked right or left of Claude Code, or in a window of its own. */
export const PLACEMENT_VALUES = ["right", "left", "window"] as const;
export type Placement = (typeof PLACEMENT_VALUES)[number];

/**
 * How wide a view's list is, next to its preview: a share of the pane, within limits (`LIST_WIDTHS` in
 * layout.tsx), or one of the ends, `hidden` (the preview takes the pane) and `full` (the list does).
 */
export const LIST_WIDTH_VALUES = ["hidden", "narrow", "normal", "wide", "wider", "full"] as const;
export type ListWidth = (typeof LIST_WIDTH_VALUES)[number];
/** A width that shares the pane with the preview. */
export type ColumnWidth = Exclude<ListWidth, ListFold>;
/** The ends: the list folded away, or spread over the pane. */
export type ListFold = "hidden" | "full";
export const isListFold = (width: ListWidth): width is ListFold => width === "hidden" || width === "full";

/** Preferences kept across restarts, shared by all projects. */
export interface Settings {
  /**
   * Start: `remember` reopens the viewer if it was open when Claude Code last
   * exited in the project, `always` opens it on every start, `never` not at all.
   */
  autoOpen: AutoOpen;
  /** Where the viewer opens, unless the session has its own placement (chosen with p in the viewer). */
  placement: Placement;
  /** q asks before the viewer quits. */
  confirmQuit: boolean;
  /** The selected list entry scrolls when it is too long. */
  marquee: boolean;
  /** Lists ordered by time get a line with the date above each day's entries. */
  dateSeparators: boolean;
  /** Every list shows its marked entries first, in a group of their own (── ★ Pinned ──); formerly pinnedGroup. */
  pinnedFavorites: boolean;
  /** Selection and scroll positions are stored per project and restored after a restart. */
  rememberPositions: boolean;
  /** Each session reopens in the view it was shown in last. */
  rememberView: boolean;
  /** The viewer takes the mouse: click opens links and selects entries, the wheel scrolls. */
  mouse: boolean;
  /** What the list filter looks at (^L / ^D in its dialog). */
  filterIn: FilterIn;
  /** Ask npm and GitHub for a newer version and the release notes when the viewer starts; `auto` also offers to install it. */
  updateMode: UpdateMode;
  /** Small screens: `single` shows list or preview in one column, without help line, status and version. The list widths are kept but not used. */
  compactView: CompactView;
  /** Compact `stacked`: the list's columns, filled one after the other like a newspaper. */
  compactColumns: CompactColumns;
  /** Compact `stacked`: the list's share of the height. */
  compactSplit: CompactSplit;
  /** The terminal title ends with the account's avatar, where one is chosen. */
  accountTitle: boolean;
  /** With two or more accounts, the "cco" in the top bar takes the account's colour as its background: `auto` from the email, a fixed one for this folder's account, or `off`. */
  accountColor: AccountColorSetting;
  /** Up to six columns (letters, symbols, emojis) shown instead of the "cco" in the top bar for this folder's account; empty keeps "cco". */
  accountAvatar: string;
  /** Chat: how much of Claude's tool calls to show (t): off, a line each, or with command and output. With it off, questions still show, framed. */
  showTools: ToolLevel;
  /** Chat: show thinking blocks (h). */
  showThinking: boolean;
  /** Chat: show the subagents Claude started, with their status. */
  showAgents: boolean;
  /** Chat: wrap long lines (w). */
  chatWrap: boolean;
  /** Changes: wrap long lines (w). */
  wrap: boolean;
  /** Changes: also show the repositories in the folders below (nested, submodules, worktrees). */
  gitNestedRepos: boolean;
  /** Plan: wrap long lines (w). */
  planWrap: boolean;
  /** Sessions: the sessions of this project folder, of the others, or of all (the filter dialog, a); with the two below formerly sessionsScope. */
  sessionsFolders: SessionsFolders;
  /** Sessions: the sessions of this account (`current`), of all found (`all`), or of the config folders named, joined by `|`. */
  sessionsAccounts: string;
  /** Sessions: the background sessions (`claude -p`, SDK, daemon) listed with the others, alone, or not at all. */
  sessionsBackground: SessionsBackground;
  /** Sessions: the remote sessions of this account (Remote Control, only with remoteApi) listed with the others, alone, or not at all. */
  sessionsRemote: SessionsRemote;
  /** Experimental: reads the Remote Control sessions of this account through the unofficial claude.ai API, with Claude Code's login. */
  remoteApi: boolean;
  /** Experimental, with remoteApi: sends prompts to Remote Control sessions and interrupts them, as the Claude app does. */
  remoteControl: boolean;
  /** Viewers of a remote session (and the Remote Control Viewer): a line above the prompt line with the context and the account's 5h and 7d windows. */
  usageLine: boolean;
  /** Sessions: the active and running sessions show in the Pinned group too, marked or not. */
  pinnedSessions: boolean;
  /** Order of the Chat and Plan lists (s in each). */
  chatOrder: ListOrder;
  planOrder: ListOrder;
  /** How far back the Sessions and Monitor lists reach until "load more". */
  sessionsRange: ListRange;
  monitorRange: ListRange;
  /** The width of each view's list (< and > in the view). */
  chatListWidth: ListWidth;
  gitListWidth: ListWidth;
  planListWidth: ListWidth;
  sessionsListWidth: ListWidth;
  monitorListWidth: ListWidth;
  todoListWidth: ListWidth;
  settingsListWidth: ListWidth;
  accountsListWidth: ListWidth;
  /** Remote Control Viewer (`cco rc-viewer`): the width of its sessions list (left) and of the selected session's turn list (middle); the chat takes the rest. */
  rcViewerSessionsWidth: ListWidth;
  rcViewerTurnsWidth: ListWidth;
  /** Accounts: the view is reachable with 0, a click on the "cco" and ←/→; /cco:accounts opens it either way. */
  viewAccounts: boolean;
  /** Accounts: the order of the other accounts (s in the view). */
  accountsOrder: AccountsOrder;
  /** Views in the tab bar; a hidden one has no tab and its number key does nothing. Settings is always shown. */
  viewChat: boolean;
  viewGit: boolean;
  viewPlan: boolean;
  viewSessions: boolean;
  viewMonitor: boolean;
  viewTodo: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoOpen: "always",
  placement: "right",
  confirmQuit: true,
  marquee: true,
  dateSeparators: true,
  pinnedFavorites: false,
  rememberPositions: true,
  rememberView: true,
  mouse: true,
  filterIn: "list",
  updateMode: "auto",
  compactView: "off",
  compactColumns: "2",
  compactSplit: "20%",
  accountTitle: true,
  accountColor: "auto",
  accountAvatar: "",
  showTools: "off",
  showThinking: false,
  showAgents: true,
  chatWrap: true,
  wrap: true,
  gitNestedRepos: true,
  planWrap: true,
  sessionsFolders: "this",
  sessionsAccounts: "current",
  sessionsBackground: "show",
  sessionsRemote: "show",
  remoteApi: false,
  remoteControl: false,
  usageLine: true,
  pinnedSessions: true,
  chatOrder: "oldest-first",
  planOrder: "oldest-first",
  sessionsRange: "7d",
  monitorRange: "7d",
  chatListWidth: "normal",
  gitListWidth: "normal",
  planListWidth: "normal",
  sessionsListWidth: "normal",
  monitorListWidth: "normal",
  todoListWidth: "normal",
  settingsListWidth: "normal",
  accountsListWidth: "normal",
  rcViewerSessionsWidth: "normal",
  rcViewerTurnsWidth: "narrow",
  viewAccounts: true,
  accountsOrder: "email",
  viewChat: true,
  viewGit: true,
  viewPlan: true,
  viewSessions: true,
  viewMonitor: true,
  viewTodo: true,
};

/** The setting that shows or hides each view; Settings has none, so the way back is always there, nor Accounts, which has no tab of its own ("cco"). */
export const VIEW_SETTINGS: Record<Exclude<Mode, "settings" | "accounts">, keyof Settings> = {
  chat: "viewChat",
  git: "viewGit",
  plan: "viewPlan",
  sessions: "viewSessions",
  monitor: "viewMonitor",
  todo: "viewTodo",
};

/** The setting of each view's list width. */
export const LIST_WIDTH_SETTINGS: Record<
  Mode,
  "chatListWidth" | "gitListWidth" | "planListWidth" | "sessionsListWidth" | "monitorListWidth" | "todoListWidth" | "settingsListWidth" | "accountsListWidth"
> = {
  chat: "chatListWidth",
  git: "gitListWidth",
  plan: "planListWidth",
  sessions: "sessionsListWidth",
  monitor: "monitorListWidth",
  todo: "todoListWidth",
  settings: "settingsListWidth",
  accounts: "accountsListWidth",
};

/** The list width one step narrower (`step` -1) or wider (1) than `width`, stopping at `hidden` and `full`. */
export function stepListWidth(width: ListWidth, step: 1 | -1): ListWidth {
  const at = LIST_WIDTH_VALUES.indexOf(width);
  return LIST_WIDTH_VALUES[Math.max(0, Math.min(LIST_WIDTH_VALUES.length - 1, at + step))];
}

/** The views of a viewer of one session (`--session`, `--remote`): its chat and its own settings. */
export const SESSION_VIEWS: readonly Mode[] = ["chat", "settings"];

/**
 * The settings a viewer of one session keeps for itself, apart from the project's viewer: how its chat looks, its
 * layout and how it is used. The rest (accounts, remote, update, the other views) it reads from the project's.
 */
export const SESSION_VIEWER_KEYS = [
  "showTools",
  "showThinking",
  "showAgents",
  "chatWrap",
  "chatOrder",
  "chatListWidth",
  "usageLine",
  "settingsListWidth",
  "compactView",
  "compactColumns",
  "compactSplit",
  "mouse",
  "marquee",
  "dateSeparators",
  "pinnedFavorites",
  "filterIn",
  "confirmQuit",
  "rememberPositions",
] as const satisfies readonly (keyof Settings)[];
export type SessionViewerKey = (typeof SESSION_VIEWER_KEYS)[number];
export const isSessionViewerKey = (key: string): key is SessionViewerKey => (SESSION_VIEWER_KEYS as readonly string[]).includes(key);

/**
 * The settings the Remote Control Viewer (`cco rc-viewer`) keeps for itself: how its chat looks and how it is used, like a viewer of
 * one session, and its two list widths. It has no compact view: three columns need the width.
 */
export const RC_VIEWER_KEYS = [
  "showTools",
  "showThinking",
  "showAgents",
  "chatWrap",
  "chatOrder",
  "rcViewerSessionsWidth",
  "rcViewerTurnsWidth",
  "usageLine",
  "settingsListWidth",
  "mouse",
  "marquee",
  "dateSeparators",
  "pinnedFavorites",
  "filterIn",
  "confirmQuit",
  "rememberPositions",
] as const satisfies readonly (keyof Settings)[];
export const isRcViewerKey = (key: string): boolean => (RC_VIEWER_KEYS as readonly string[]).includes(key);
/** The settings only the Remote Control Viewer has: the project's viewer does not show them. */
export const isRcViewerOnlyKey = (key: string): boolean => key === "rcViewerSessionsWidth" || key === "rcViewerTurnsWidth";
/** The settings only a viewer of one session and the Remote Control Viewer use: the project's viewer does not list them. */
export const isViewerOnlyKey = (key: string): boolean => key === "usageLine";

/**
 * Which settings of its own this process keeps apart from the project's viewer: a viewer of one session's
 * (`session`), the Remote Control Viewer's (`rcViewer`), or none. Both show only `SESSION_VIEWS`.
 */
export type OwnSettings = "session" | "rcViewer";
let ownKind: OwnSettings | undefined;
export function setOwnSettings(kind: OwnSettings | undefined): void {
  ownKind = kind;
}
/** Whether this process is a viewer of one session: it shows only `SESSION_VIEWS` and keeps its own settings. */
export function setSessionViewer(on: boolean): void {
  ownKind = on ? "session" : undefined;
}
export const isSessionViewer = () => ownKind === "session";
/** Whether this process is the Remote Control Viewer (`cco rc-viewer`). */
export const isRcViewer = () => ownKind === "rcViewer";
/** Whether `key` is one this process keeps for itself (all of them for the project's viewer). */
export const isOwnKey = (key: string): boolean => (ownKind === "rcViewer" ? isRcViewerKey(key) : ownKind === "session" ? isSessionViewerKey(key) : true);

/** Whether `mode` is shown in the tab bar and reachable by its key. */
export function isViewShown(settings: Settings, mode: Mode): boolean {
  if (ownKind && !SESSION_VIEWS.includes(mode)) return false;
  if (mode === "accounts") return settings.viewAccounts;
  return mode === "settings" || settings[VIEW_SETTINGS[mode]] === true;
}

/** The views in tab order. */
const TAB_ORDER: Mode[] = ["accounts", "chat", "git", "plan", "sessions", "monitor", "settings", "todo"];

/** The shown view after (`step` 1) or before (-1) `mode` in tab order, wrapping around; for Tab and Shift+Tab. */
export function nextShownView(settings: Settings, mode: Mode, step: 1 | -1): Mode {
  const n = TAB_ORDER.length;
  const at = TAB_ORDER.indexOf(mode);
  for (let i = 1; i <= n; i++) {
    const next = TAB_ORDER[(at + step * i + n * n) % n];
    if (isViewShown(settings, next)) return next;
  }
  return mode;
}

/** `mode` if it is shown, else the first shown view (Settings always is). */
export function shownView(settings: Settings, mode: Mode): Mode {
  // Accounts is the "cco" before the tabs: never the stand-in for a hidden view.
  return isViewShown(settings, mode) ? mode : (TAB_ORDER.find((m) => m !== "accounts" && isViewShown(settings, m)) ?? "settings");
}

/** Allowed values of the settings that are not on/off. */
const CHOICES: Partial<Record<keyof Settings, readonly string[]>> = {
  autoOpen: AUTO_OPEN_VALUES,
  placement: PLACEMENT_VALUES,
  filterIn: FILTER_IN_VALUES,
  updateMode: UPDATE_VALUES,
  compactView: COMPACT_VIEW_VALUES,
  compactColumns: COMPACT_COLUMNS_VALUES,
  compactSplit: COMPACT_SPLIT_VALUES,
  accountColor: ACCOUNT_COLOR_VALUES,
  showTools: TOOL_LEVELS,
  chatOrder: ORDER_VALUES,
  planOrder: ORDER_VALUES,
  sessionsFolders: SESSIONS_FOLDERS_VALUES,
  sessionsBackground: SESSIONS_BACKGROUND_VALUES,
  sessionsRemote: SESSIONS_REMOTE_VALUES,
  sessionsRange: RANGE_VALUES,
  monitorRange: RANGE_VALUES,
  chatListWidth: LIST_WIDTH_VALUES,
  gitListWidth: LIST_WIDTH_VALUES,
  planListWidth: LIST_WIDTH_VALUES,
  sessionsListWidth: LIST_WIDTH_VALUES,
  monitorListWidth: LIST_WIDTH_VALUES,
  todoListWidth: LIST_WIDTH_VALUES,
  settingsListWidth: LIST_WIDTH_VALUES,
  accountsListWidth: LIST_WIDTH_VALUES,
  rcViewerSessionsWidth: LIST_WIDTH_VALUES,
  rcViewerTurnsWidth: LIST_WIDTH_VALUES,
  accountsOrder: ACCOUNTS_ORDER_VALUES,
};

export function settingsFile(): string {
  return join(claudeDir(), "cco", "settings.json");
}

/** The settings of the viewers of one session (`SESSION_VIEWER_KEYS`), next to settings.json. */
export function sessionViewerSettingsFile(): string {
  return join(claudeDir(), "cco", "settings.session-viewer.json");
}

/** The Remote Control Viewer's settings (`RC_VIEWER_KEYS`), next to settings.json. */
export function rcViewerSettingsFile(): string {
  return join(claudeDir(), "cco", "settings.rc-viewer.json");
}

/** Before its rename the Remote Control Viewer was the keeper: its settings file is taken over once. */
export function takeOverKeeperSettings(): void {
  const old = join(claudeDir(), "cco", "settings.keeper.json");
  const file = rcViewerSettingsFile();
  if (existsSync(old) && !existsSync(file)) {
    try {
      renameSync(old, file);
    } catch {
      // Another process took it over first.
    }
  }
}

/** The file of the settings `kind` keeps for itself. */
const ownFileOf = (kind: OwnSettings) => (kind === "rcViewer" ? rcViewerSettingsFile() : sessionViewerSettingsFile());

/** The file this process's settings come from first: a viewer of one session's or the Remote Control Viewer's own, else settings.json. */
export const ownSettingsFile = () => (ownKind ? ownFileOf(ownKind) : settingsFile());

/** Stored settings over the defaults; unknown or mistyped values fall back to the default. */
function validated(stored: Partial<Record<keyof Settings, unknown>>): Settings {
  // showTools was on/off before it got levels.
  if (typeof stored.showTools === "boolean") stored.showTools = stored.showTools ? "compact" : "off";
  // updateMode was the on/off setting updateCheck before it got auto; since every change stored all settings, only off was chosen.
  const legacy = (stored as { updateCheck?: unknown }).updateCheck;
  if (stored.updateMode === undefined && legacy === false) stored.updateMode = "off";
  // pinnedFavorites was pinnedGroup before the active sessions could be pinned too.
  const group = (stored as { pinnedGroup?: unknown }).pinnedGroup;
  if (stored.pinnedFavorites === undefined && typeof group === "boolean") stored.pinnedFavorites = group;
  // accountColor was the colour of this account alone; the on/off setting accountBadge is its value off now.
  const badge = (stored as { accountBadge?: unknown }).accountBadge;
  if (stored.accountColor === undefined && badge === false) stored.accountColor = "off";
  // sessionsFolders and sessionsAccounts were sessionsScope (a went round four values), which was the on/off setting allProjects before.
  const allProjects = (stored as { allProjects?: unknown }).allProjects;
  const scope = (stored as { sessionsScope?: unknown }).sessionsScope ?? (typeof allProjects === "boolean" ? (allProjects ? "all" : "project") : undefined);
  const legacyScope = typeof scope === "string" ? LEGACY_SCOPES[scope] : undefined;
  if (legacyScope && stored.sessionsFolders === undefined && stored.sessionsAccounts === undefined) Object.assign(stored, legacyScope);
  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = stored[key];
    if (typeof value !== typeof DEFAULT_SETTINGS[key]) continue;
    const choices = CHOICES[key];
    if (choices && !choices.includes(value as string)) continue;
    if (key === "accountAvatar" && !isAvatarSetting(value)) continue;
    if (key === "sessionsAccounts" && !isAccountsSetting(value)) continue;
    result[key] = value;
  }
  return result as unknown as Settings;
}

/** The project's viewer's settings, from settings.json. */
export function readMainSettings(): Settings {
  return validated(readJson<Partial<Record<keyof Settings, unknown>>>(settingsFile()) ?? {});
}

/** The keys `kind` keeps for itself out of `settings`. */
const ownPart = (kind: OwnSettings, settings: Partial<Settings>): Partial<Settings> =>
  Object.fromEntries(Object.entries(settings).filter(([key]) => (kind === "rcViewer" ? isRcViewerKey(key) : isSessionViewerKey(key))));

/** The keys of the viewers of one session out of `settings`. */
export const sessionViewerPart = (settings: Partial<Settings>): Partial<Settings> => ownPart("session", settings);
/** The Remote Control Viewer's keys out of `settings`. */
export const rcViewerPart = (settings: Partial<Settings>): Partial<Settings> => ownPart("rcViewer", settings);

/** The settings `kind` keeps for itself as they apply, over `main` for the rest; undefined while its file does not exist. */
function readOwnSettings(kind: OwnSettings, main: Settings): Settings | undefined {
  const stored = readJson<Partial<Record<keyof Settings, unknown>>>(ownFileOf(kind));
  if (stored === undefined) return undefined;
  return { ...main, ...ownPart(kind, validated(stored)) };
}

/**
 * The settings of the viewers of one session as they apply: their file's values, each checked like settings.json's,
 * over `main` for the rest. Undefined while the file does not exist.
 */
export function readSessionViewerSettings(main = readMainSettings()): Settings | undefined {
  return readOwnSettings("session", main);
}

/** The Remote Control Viewer's settings as they apply, like `readSessionViewerSettings`. */
export function readRcViewerSettings(main = readMainSettings()): Settings | undefined {
  return readOwnSettings("rcViewer", main);
}

/**
 * The settings that apply in this process. A viewer of one session (or the Remote Control Viewer) reads its own over the project's;
 * the first one to start takes the project's viewer's values (its file does not exist yet), which stay apart from then on.
 */
export function readSettings(): Settings {
  const main = readMainSettings();
  if (!ownKind) return main;
  const own = readOwnSettings(ownKind, main);
  if (own) return own;
  writeJson(ownFileOf(ownKind), ownPart(ownKind, main));
  return main;
}

const listeners = new Set<() => void>();

/** Calls `listener` whenever this process changes a setting; returns the unsubscribe function. */
export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tells the listeners to read the settings again, e.g. after another viewer changed them (F5). */
export function reloadSettings(): void {
  for (const listener of listeners) listener();
}

/** Keys of former formats, which `readSettings` takes over and a write leaves out. */
const FORMER_KEYS = new Set(["updateCheck", "pinnedGroup", "accountBadge", "sessionsScope", "allProjects"]);

/** Keys of `file` this version does not know: a newer one's, which a viewer still running older code must not drop. */
function newerKeys(file: string): Record<string, unknown> {
  const stored = readJson<Record<string, unknown>>(file) ?? {};
  return Object.fromEntries(Object.entries(stored).filter(([key]) => !(key in DEFAULT_SETTINGS) && !FORMER_KEYS.has(key)));
}

/** Writes the settings `kind` keeps for itself: their part of `values`, over the newer keys their file holds. */
function writeOwnSettings(kind: OwnSettings, values: Partial<Settings>): void {
  const file = ownFileOf(kind);
  writeJson(file, { ...newerKeys(file), ...ownPart(kind, values) });
}

/**
 * Merges `changes` into the stored settings, re-reading first so other viewers' changes survive. A viewer of one
 * session (or the Remote Control Viewer) writes its own keys to its own file, and only the rest to settings.json.
 */
export function updateSettings(changes: Partial<Settings>): void {
  const own = ownKind ? ownPart(ownKind, changes) : {};
  const rest = Object.fromEntries(Object.entries(changes).filter(([key]) => !(key in own)));
  if (ownKind && Object.keys(own).length > 0) writeOwnSettings(ownKind, { ...readSettings(), ...own });
  if (Object.keys(rest).length > 0) writeJson(settingsFile(), { ...newerKeys(settingsFile()), ...readMainSettings(), ...rest });
  for (const listener of listeners) listener();
}

/**
 * Sets the settings this process keeps for itself (a viewer of one session's, the Remote Control Viewer's) to the defaults, or to
 * the project's viewer's values (`from` main).
 */
export function resetSessionViewerSettings(from: "defaults" | "main"): void {
  const kind = ownKind ?? "session";
  writeOwnSettings(kind, from === "main" ? readMainSettings() : DEFAULT_SETTINGS);
  for (const listener of listeners) listener();
}
