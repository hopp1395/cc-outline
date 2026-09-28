import { escapeMd, fence, type ToolLevel, type ToolOutcome } from "./tools.js";

/**
 * Claude in Chrome (`mcp__claude-in-chrome__*`): one line per browser action,
 * verb first, without tab ids, and the page it ran on from the result's
 * "Tab Context". Its results are text blocks: the action's result, screenshots
 * as images, the tab context and sometimes a <system-reminder>.
 */

const PREFIX = "mcp__claude-in-chrome__";

export const isChromeTool = (name: string) => name.startsWith(PREFIX);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Inline code on one line, cut at `max` characters. */
function code(s: string, max = 80): string {
  const one = s.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return `\`${one.length > max ? one.slice(0, max - 1) + "…" : one}\``;
}

const firstLine = (s: string, max = 80) => {
  const line = s.trim().split("\n")[0]?.trim() ?? "";
  return escapeMd(line.length > max ? line.slice(0, max - 1) + "…" : line);
};

const point = (v: unknown) => (Array.isArray(v) && v.length === 2 ? `(${v[0]}, ${v[1]})` : undefined);

/** A URL without its scheme, cut in the middle of long paths. */
function shortUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, "");
  return bare.length > 70 ? bare.slice(0, 69) + "…" : bare;
}

const CLICKS: Record<string, string> = {
  left_click: "click",
  right_click: "right click",
  middle_click: "middle click",
  double_click: "double click",
  triple_click: "triple click",
};

/** Symbol, verb and argument of one action (`tool` without the prefix). Actions on the page read as they are (click, type); the others say "browser", so they are not taken for other tools. */
function actionHead(tool: string, input: unknown): { symbol: string; verb: string; arg?: string } {
  const i = obj(input);
  switch (tool) {
    case "navigate": {
      const url = str(i.url) ?? "";
      return url === "back" || url === "forward" ? { symbol: "↗", verb: url } : { symbol: "↗", verb: "navigate", arg: code(shortUrl(url), 72) };
    }
    case "computer": {
      const action = str(i.action) ?? "";
      const target = str(i.ref) ? code(str(i.ref)!) : point(i.coordinate);
      if (CLICKS[action]) return { symbol: "⊙", verb: CLICKS[action], arg: target };
      switch (action) {
        case "screenshot":
          return { symbol: "▣", verb: "screenshot" };
        case "zoom":
          return { symbol: "▣", verb: "zoom", arg: Array.isArray(i.region) ? `(${i.region.join(", ")})` : undefined };
        case "left_click_drag":
          return { symbol: "⊙", verb: "drag", arg: [point(i.start_coordinate), point(i.coordinate)].filter(Boolean).join(" → ") || undefined };
        case "hover":
          return { symbol: "⊙", verb: "hover", arg: target };
        case "type":
          return { symbol: "⌨", verb: "type", arg: code(`"${str(i.text) ?? ""}"`) };
        case "key":
          return { symbol: "⌨", verb: "key", arg: code(str(i.text) ?? "") + (num(i.repeat) && num(i.repeat)! > 1 ? ` ×${num(i.repeat)}` : "") };
        case "scroll":
          return { symbol: "↕", verb: "scroll", arg: [str(i.scroll_direction), num(i.scroll_amount)].filter((x) => x !== undefined).join(" ") || undefined };
        case "scroll_to":
          return { symbol: "↕", verb: "scroll to", arg: target };
        case "wait":
          return { symbol: "◷", verb: "wait", arg: num(i.duration) !== undefined ? `${num(i.duration)} s` : undefined };
        default:
          return { symbol: "⚙", verb: action || "computer", arg: target };
      }
    }
    case "find":
      return { symbol: "⌕", verb: "browser find", arg: code(str(i.query) ?? "") };
    case "javascript_tool":
      return { symbol: "{}", verb: "browser javascript", arg: code(str(i.text) ?? "", 60) };
    case "get_page_text":
      return { symbol: "≡", verb: "browser page text" };
    case "read_page":
      return { symbol: "≡", verb: "browser read page", arg: str(i.filter) };
    case "read_console_messages":
      return { symbol: "⚠", verb: "browser console", arg: str(i.pattern) && i.pattern !== "." ? code(str(i.pattern)!) : undefined };
    case "read_network_requests":
      return { symbol: "⇄", verb: "browser network", arg: str(i.pattern) && i.pattern !== "." ? code(str(i.pattern)!) : undefined };
    case "form_input":
      return { symbol: "⌨", verb: "browser form input", arg: [str(i.ref) && code(str(i.ref)!), i.value !== undefined && code(`"${String(i.value)}"`)].filter(Boolean).join(" = ") || undefined };
    case "tabs_context_mcp":
      return { symbol: "▭", verb: "browser tabs" };
    case "tabs_create_mcp":
      return { symbol: "▭", verb: "new browser tab" };
    case "tabs_close_mcp":
      return { symbol: "▭", verb: "close browser tab" };
    case "resize_window":
      return { symbol: "⤢", verb: "resize browser", arg: num(i.width) && num(i.height) ? `${num(i.width)}×${num(i.height)}` : undefined };
    case "list_connected_browsers":
      return { symbol: "◎", verb: "browsers connected" };
    case "select_browser":
      return { symbol: "◎", verb: "select browser" };
    case "browser_batch":
      return { symbol: "⧉", verb: "browser batch", arg: plural(Array.isArray(i.actions) ? i.actions.length : 0, "action") };
    default:
      return { symbol: "⚙", verb: tool.replace(/_mcp$/, "").replace(/_/g, " ") };
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the result of an action says briefly, after its line; undefined when the line says it all (clicks, keys). */
function actionSummary(tool: string, input: unknown, text: string, context = ""): string | undefined {
  const action = str(obj(input).action);
  if (tool === "computer") {
    if (action === "screenshot") return /\((\d+)x(\d+)/.exec(text)?.slice(1).join("×");
    if (action === "zoom") return /(\d+)x(\d+) pixels/.exec(text)?.slice(1).join("×");
    return undefined;
  }
  switch (tool) {
    case "navigate":
    case "tabs_create_mcp":
    case "resize_window":
      return undefined;
    case "find": {
      const n = /Found (\d+) matching/.exec(text)?.[1];
      return n ? `→ ${plural(Number(n), "element")}` : firstLine(text, 60);
    }
    case "tabs_context_mcp": {
      const tabs = (context.match(/• tabId/g) ?? []).length;
      return tabs ? plural(tabs, "tab") : undefined;
    }
    case "list_connected_browsers": {
      try {
        const list = JSON.parse(text);
        if (Array.isArray(list)) return list.length ? plural(list.length, "browser") : "none";
      } catch {
        // Not the JSON list: fall through to its first line.
      }
      return firstLine(text, 60);
    }
    case "javascript_tool":
      // Results are often JSON over several lines: one line of it.
      return text.trim() ? code(text, 60) : undefined;
    case "get_page_text":
    case "read_page":
      return text ? `${Math.max(1, Math.round(text.length / 1000))}k chars` : undefined;
    default:
      return text.trim() ? firstLine(text, 60) : undefined;
  }
}

/** Markdown of one action's line. */
function actionLine(tool: string, input: unknown, summary?: string): string {
  const { symbol, verb, arg } = actionHead(tool, input);
  return `**${escapeMd(symbol)} ${escapeMd(verb)}**${arg ? ` ${arg}` : ""}${summary ? ` · ${summary}` : ""}`;
}

/** The title of the tab an action ran on, from the result's "Tab Context". */
export function tabPage(context: string): string | undefined {
  const id = /Executed on tabId: (\d+)/.exec(context)?.[1];
  if (!id) return undefined;
  const tab = new RegExp(`• tabId ${id}: "(.*)" \\("(.*)"\\)\\s*$`, "m").exec(context);
  if (!tab) return undefined;
  return tab[1].trim() || shortUrl(tab[2]);
}

/** The text blocks of a result, without system reminders; the tab context apart. */
function resultParts(content: unknown): { texts: string[]; context?: string } {
  const blocks = typeof content === "string" ? [content] : Array.isArray(content) ? content.map((b) => (obj(b).type === "text" ? (str(obj(b).text) ?? "") : "")) : [];
  const texts: string[] = [];
  let context: string | undefined;
  for (const raw of blocks) {
    const t = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
    const at = t.indexOf("Tab Context:");
    if (at >= 0) {
      context = t.slice(at);
      if (t.slice(0, at).trim()) texts.push(t.slice(0, at).trim());
    } else if (t.trim()) texts.push(t.trim());
  }
  return { texts, context };
}

/** The outcome of a successful Claude in Chrome call (errors take the general path). */
export function chromeOutcome(name: string, input: unknown, content: unknown): ToolOutcome {
  const tool = name.slice(PREFIX.length);
  const { texts, context } = resultParts(content);
  const page = context ? tabPage(context) : undefined;
  const text = texts.join("\n");
  if (tool === "browser_batch") {
    const actions = Array.isArray(obj(input).actions) ? (obj(input).actions as unknown[]) : [];
    // One "[name] result" or "[computer:action] result" text per action, in order.
    const results = texts.filter((t) => /^\[[\w:]+\]/.test(t)).map((t) => t.replace(/^\[[\w:]+\]\s*/, ""));
    const steps = actions.map((a, i) => actionLine(str(obj(a).name) ?? "", obj(a).input, results[i] !== undefined ? actionSummary(str(obj(a).name) ?? "", obj(a).input, results[i]) : undefined));
    return { status: "ok", steps, ...(page ? { page } : {}) };
  }
  const detail =
    tool === "javascript_tool"
      ? [fence(str(obj(input).text) ?? "", "js"), ...(text ? [fence(tailLines(text))] : [])].join("\n\n")
      : tool === "find" || tool === "read_console_messages" || tool === "read_network_requests"
        ? text
          ? fence(tailLines(text))
          : undefined
        : undefined;
  return { status: "ok", summary: actionSummary(tool, input, text, context), ...(detail ? { detail } : {}), ...(page ? { page } : {}) };
}

const tailLines = (text: string, n = 10) => text.trim().split("\n").slice(0, n).join("\n") + (text.trim().split("\n").length > n ? "\n…" : "");

/** A Claude in Chrome call at `level` (not "off"): its line, a batch's actions below it, and details in full. */
export function chromeMarkdown(name: string, input: unknown, outcome: ToolOutcome | undefined, level: ToolLevel): string {
  const tool = name.slice(PREFIX.length);
  const line = actionLine(tool, input, outcome?.summary);
  if (tool === "browser_batch") {
    const steps = outcome?.steps ?? (Array.isArray(obj(input).actions) ? (obj(input).actions as unknown[]).map((a) => actionLine(str(obj(a).name) ?? "", obj(a).input)) : []);
    return [line, ...steps.map((s) => `- ${s}`)].join("\n");
  }
  return level === "full" && outcome?.detail ? `${line}\n\n${outcome.detail}` : line;
}
