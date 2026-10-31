/**
 * The status lines cco offers Claude Code (`statusLine` in its settings.json): presets made of segments, each a piece of
 * what Claude Code hands the command on stdin or of what cco keeps in its files. Pure, so the Settings view previews them
 * with the same code.
 */

/** The presets, and the setting's values around them: leave Claude Code's alone, none, the user's own command. */
export const STATUS_LINE_PRESETS = ["minimal", "compact", "detailed", "cco"] as const;
export type StatusLinePreset = (typeof STATUS_LINE_PRESETS)[number];
export const STATUS_LINE_VALUES = ["unchanged", "off", "own", ...STATUS_LINE_PRESETS] as const;
export type StatusLineSetting = (typeof STATUS_LINE_VALUES)[number];
export const isStatusLinePreset = (value: unknown): value is StatusLinePreset => (STATUS_LINE_PRESETS as readonly unknown[]).includes(value);

/** A usage window of the account, as Claude Code reports it. */
interface RateLimit {
  used_percentage?: number;
  /** Seconds (or milliseconds) since the epoch, or an ISO time. */
  resets_at?: number | string;
}

/** What Claude Code writes to the command's stdin; every part may be missing. */
export interface StatusInput {
  session_id?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  cost?: { total_cost_usd?: number; total_duration_ms?: number; total_lines_added?: number; total_lines_removed?: number };
  context_window?: {
    used_percentage?: number;
    context_window_size?: number;
    current_usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  };
  rate_limits?: { five_hour?: RateLimit; seven_day?: RateLimit };
}

/** What cco adds from its own files. */
export interface StatusExtras {
  /** The branch of the repository the session works in, or a short commit when detached. */
  branch?: string;
  /** The account of the config folder: what stands for it (avatar, else the email's name) and its colour, if it has one. */
  account?: { label: string; color?: string };
  /** Open items in the project's to-do lists. */
  todos?: number;
}

export const SEGMENTS = ["model", "context", "fiveHour", "sevenDay", "branch", "cost", "duration", "lines", "account", "todos"] as const;
export type Segment = (typeof SEGMENTS)[number];

/** The segments of each preset, one array per line. */
export const PRESET_LINES: Record<StatusLinePreset, Segment[][]> = {
  minimal: [["model", "context"]],
  compact: [["model", "context", "fiveHour", "sevenDay"]],
  detailed: [
    ["model", "context", "fiveHour", "sevenDay"],
    ["branch", "cost", "duration", "lines"],
  ],
  cco: [["account", "model", "context", "fiveHour", "sevenDay", "todos"]],
};

const RESET = "\u001b[0m";
const sgr = (code: number | string, text: string) => `\u001b[${code}m${text}${RESET}`;
const dim = (text: string) => sgr(2, text);
const green = (text: string) => sgr(32, text);
const red = (text: string) => sgr(31, text);
/** Green, yellow from 75 %, red from 90 %: a window that runs out soon stands out. */
const level = (percent: number) => sgr(percent >= 90 ? 31 : percent >= 75 ? 33 : 32, `${percent}%`);

/** The console colours by name (as the account colours are named): foreground codes; the background is 10 more. */
const COLOR_CODES: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  blackBright: 90,
  redBright: 91,
  greenBright: 92,
  yellowBright: 93,
  blueBright: 94,
  magentaBright: 95,
  cyanBright: 96,
  whiteBright: 97,
};
/** Black on the bright colours and white, white on the others, as the top bar draws the account. */
const onColor = (color: string, text: string) => {
  const code = COLOR_CODES[color];
  if (code === undefined) return text;
  const light = color === "white" || color.endsWith("Bright");
  return `\u001b[${code + 10};${light ? 30 : 97}m ${text} ${RESET}`;
};

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function timeOf(value: number | string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

const percent = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined);

/** A window: its share used and when it starts anew, the 7-day one with the day; – while Claude Code has not reported it. */
function windowSegment(label: string, limit: RateLimit | undefined, withDay: boolean): string {
  const used = percent(limit?.used_percentage);
  if (used === undefined) return `${label} ${dim("–")}`;
  const at = timeOf(limit?.resets_at);
  const when = at ? ` ${dim(`${withDay ? `${DAYS[at.getDay()]} ` : ""}${pad(at.getHours())}:${pad(at.getMinutes())}`)}` : "";
  return `${label} ${level(used)}${when}`;
}

/** The share of the context window the last request used, from Claude Code's percentage or its tokens. */
function contextPercent(input: StatusInput): number | undefined {
  const cw = input.context_window;
  const given = percent(cw?.used_percentage);
  if (given !== undefined) return given;
  const usage = cw?.current_usage;
  if (!usage || !cw?.context_window_size) return undefined;
  const tokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return Math.round((tokens / cw.context_window_size) * 100);
}

/** 3 h 20 min as `3h20m`, 12 min as `12m`, under a minute as `<1m`. */
export function shortDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h${pad(minutes % 60)}m` : `${minutes}m`;
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** One segment's text, or undefined where there is nothing to show (it is then left out). */
export function segmentText(segment: Segment, input: StatusInput, extras: StatusExtras): string | undefined {
  switch (segment) {
    case "model":
      return input.model?.display_name ?? input.model?.id;
    case "context": {
      const used = contextPercent(input);
      return used === undefined ? `ctx ${dim("–")}` : `ctx ${level(used)}`;
    }
    case "fiveHour":
      return windowSegment("5h", input.rate_limits?.five_hour, false);
    case "sevenDay":
      return windowSegment("7d", input.rate_limits?.seven_day, true);
    case "branch":
      return extras.branch ? `⎇ ${extras.branch}` : undefined;
    case "cost": {
      const usd = number(input.cost?.total_cost_usd);
      return usd === undefined ? undefined : `$${usd.toFixed(2)}`;
    }
    case "duration": {
      const ms = number(input.cost?.total_duration_ms);
      return ms === undefined ? undefined : `⏱ ${shortDuration(ms)}`;
    }
    case "lines": {
      const added = number(input.cost?.total_lines_added);
      const removed = number(input.cost?.total_lines_removed);
      return added === undefined && removed === undefined ? undefined : `${green(`+${added ?? 0}`)} ${red(`−${removed ?? 0}`)}`;
    }
    case "account":
      return extras.account ? (extras.account.color ? onColor(extras.account.color, extras.account.label) : extras.account.label) : undefined;
    case "todos":
      return extras.todos ? `☐ ${extras.todos}` : undefined;
  }
}

const SEPARATOR = dim(" | ");

/** The preset's lines: each line's segments that have something to show, joined; an empty line is left out. */
export function renderStatusLine(preset: StatusLinePreset, input: StatusInput, extras: StatusExtras = {}): string[] {
  return PRESET_LINES[preset]
    .map((segments) =>
      segments
        .map((segment) => {
          try {
            return segmentText(segment, input, extras);
          } catch {
            // A segment that cannot be drawn is left out; the line stays.
            return undefined;
          }
        })
        .filter((text): text is string => text !== undefined && text !== "")
        .join(SEPARATOR),
    )
    .filter((line) => line !== "");
}

/** Example input for the preview before Claude Code has run the command once. */
export function sampleInput(now = Date.now()): StatusInput {
  const hour = 3600 * 1000;
  return {
    model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
    cost: { total_cost_usd: 4.27, total_duration_ms: 1.4 * hour, total_lines_added: 312, total_lines_removed: 48 },
    context_window: { used_percentage: 42 },
    rate_limits: {
      five_hour: { used_percentage: 23, resets_at: Math.round((now + 2.2 * hour) / 1000) },
      seven_day: { used_percentage: 78, resets_at: Math.round((now + 76 * hour) / 1000) },
    },
  };
}
