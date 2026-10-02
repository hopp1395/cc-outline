import { escapeMd, fence, type BrowserStep, type ResultImage, type ToolLevel, type ToolOutcome } from "./tools.js";

/**
 * Browser tools: Claude in Chrome (`mcp__claude-in-chrome__*`) and the
 * desktop app's Browser pane (`mcp__Claude_Browser__*`, from a cloud session
 * `mcp__remote-devices__Claude_Browser__*`), which share most actions. One
 * line per browser action, verb first, without tab ids, and the page it ran on
 * from the result's "Tab Context". Results are text blocks: the action's
 * result, screenshots as images (the Browser pane also saves them and names
 * the file in an `[Image: source: …]` text), the tab context and sometimes a
 * <system-reminder>.
 */

const CHROME = "mcp__claude-in-chrome__";
const PREFIXES = [CHROME, "mcp__Claude_Browser__", "mcp__remote-devices__Claude_Browser__"];

const prefixOf = (name: string) => PREFIXES.find((p) => name.startsWith(p));
export const isBrowserTool = (name: string) => prefixOf(name) !== undefined;
/** The action of a browser tool: its name without the prefix. */
export const browserAction = (name: string) => name.slice(prefixOf(name)?.length ?? 0);
/** What the frame of browser actions is called. */
export const browserTitle = (name: string) => (name.startsWith(CHROME) ? "Claude in Chrome" : "Browser");
/** Actions whose page is shown after them: they lead there. */
export const navigates = (name: string) => /^(navigate|preview_start)$/.test(browserAction(name));

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Inline code on one line, cut at `max` characters. */
function code(s: string, max = 80): string {
  const one = s.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return `\`${one.length > max ? one.slice(0, max - 1) + "…" : one}\``;
}

const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

const firstLine = (s: string, max = 80) => escapeMd(cut(s.trim().split("\n")[0]?.trim() ?? "", max));

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
    case "preview_start":
      return { symbol: "↗", verb: "open browser", arg: str(i.url) ? code(shortUrl(str(i.url)!), 72) : undefined };
    case "computer": {
      const action = str(i.action) ?? "";
      // The Browser pane's calls say what a click is for; better than a ref or a point.
      const purpose = str(i.action_summary) ? escapeMd(cut(str(i.action_summary)!, 80)) : undefined;
      const target = purpose ?? (str(i.ref) ? code(str(i.ref)!) : point(i.coordinate));
      if (CLICKS[action]) return { symbol: "⊙", verb: CLICKS[action], arg: target };
      switch (action) {
        case "screenshot":
          return { symbol: "▣", verb: "screenshot" };
        case "zoom":
          return { symbol: "▣", verb: "zoom", arg: Array.isArray(i.region) ? `(${i.region.join(", ")})` : undefined };
        case "left_click_drag":
          return { symbol: "⊙", verb: "drag", arg: purpose ?? ([point(i.start_coordinate), point(i.coordinate)].filter(Boolean).join(" → ") || undefined) };
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
    case "tabs_select":
      return { symbol: "▭", verb: "select browser tab" };
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

/** The matches a find listed: "- ref_1: link …" (Chrome) or "- link "…" [ref_21] …" (Browser pane). */
const findMatches = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());

/** What the result of an action says briefly, after its line; undefined when the line says it all (clicks, keys). */
function actionSummary(tool: string, input: unknown, text: string, context = ""): string | undefined {
  const action = str(obj(input).action);
  if (tool === "computer") {
    // "Successfully captured screenshot (1568x698, jpeg)", "Screenshot size: 800x600", "1024x768 pixels".
    if (action === "screenshot" || action === "zoom") return /(\d+)x(\d+)/.exec(text)?.slice(1).join("×") ?? (action === "zoom" ? firstLine(text, 60) || undefined : undefined);
    return undefined;
  }
  switch (tool) {
    case "navigate":
    case "preview_start":
    case "tabs_create_mcp":
    case "tabs_select":
    case "resize_window":
      return undefined;
    case "find": {
      const n = /Found (\d+) match/.exec(text)?.[1];
      if (n) return `→ ${plural(Number(n), "element")}`;
      return /^No match/.test(text.trim()) ? "→ none" : firstLine(text, 60);
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
    case "read_network_requests": {
      const requests = text.split("\n").filter((l) => /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S/.test(l)).length;
      return requests ? plural(requests, "request") : firstLine(text, 60);
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

/** Lines of what an action found, shown below it in the browser frame. */
const BRIEF_LINES = 5;
const BRIEF_WIDTH = 100;

/** A few plain lines of an action's result worth reading without opening anything: matches, a script's value, console messages. */
function actionBrief(tool: string, text: string): string[] | undefined {
  let lines: string[];
  switch (tool) {
    case "find":
      lines = findMatches(text);
      break;
    case "javascript_tool":
      lines = text.trim().split("\n");
      // A value of one line is already in the action's line.
      if (lines.length === 1) return undefined;
      break;
    case "read_console_messages":
      lines = /^No console/i.test(text.trim()) ? [] : text.trim().split("\n");
      break;
    default:
      return undefined;
  }
  lines = lines.map((l) => l.trimEnd()).filter((l) => l.trim());
  if (lines.length === 0) return undefined;
  const shown = lines.slice(0, BRIEF_LINES).map((l) => cut(l, BRIEF_WIDTH));
  return lines.length > BRIEF_LINES ? [...shown, `… ${lines.length - BRIEF_LINES} more`] : shown;
}

/** Markdown of one action's line. */
function actionLine(tool: string, input: unknown, summary?: string): string {
  const { symbol, verb, arg } = actionHead(tool, input);
  return `**${escapeMd(symbol)} ${escapeMd(verb)}**${arg ? ` ${arg}` : ""}${summary ? ` · ${summary}` : ""}`;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The title of the tab an action ran on, from the result's "Tab Context". Chrome's tab ids are numbers, the Browser pane's names ("seed", "tab-1"). */
export function tabPage(context: string): string | undefined {
  const id = /Executed on tabId: ([\w-]+)/.exec(context)?.[1];
  if (!id) return undefined;
  const tab = new RegExp(`• tabId ${escapeRegExp(id)}: "(.*)" \\("(.*)"\\)\\s*$`, "m").exec(context);
  if (!tab) return undefined;
  return tab[1].trim() || shortUrl(tab[2]);
}

/** "[Image: source: C:\…\tool-results\mcp-Claude_Browser-blob-….jpg]": where the Browser pane saved the image before it. */
const IMAGE_SOURCE = /^\[Image: source: (.+)\]$/;
/** "(captured at origin https://…)", which the Browser pane adds to its results. */
const ORIGIN = /\n*\(captured at origin [^)]*\)\s*$/;
/** A batch result's text starts with its action: "[navigate] …", "[computer:screenshot] …". */
const STEP = /^\[[\w:]+\]/;

/**
 * The parts of a result: its text blocks without system reminders, the tab
 * context apart (the last one, after the last action), and its images, each
 * with the batch action it follows.
 */
function resultParts(content: unknown, batch: boolean): { texts: string[]; context?: string; images: ResultImage[] } {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.map(obj) : [];
  const texts: string[] = [];
  const images: ResultImage[] = [];
  let context: string | undefined;
  let step = -1;
  for (const block of blocks) {
    if (block.type === "image") {
      images.push(batch && step >= 0 ? { step } : {});
      continue;
    }
    if (block.type !== "text") continue;
    const raw = (str(block.text) ?? "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
    const source = IMAGE_SOURCE.exec(raw.trim())?.[1];
    if (source) {
      const last = images.at(-1);
      if (last && !last.path) last.path = source;
      continue;
    }
    const at = raw.indexOf("Tab Context:");
    const own = (at >= 0 ? raw.slice(0, at) : raw).replace(ORIGIN, "").trim();
    if (at >= 0) context = raw.slice(at);
    if (!own) continue;
    if (batch && STEP.test(own)) step++;
    texts.push(own);
  }
  return { texts, context, images };
}

/** The outcome of a successful browser call (errors take the general path). */
export function chromeOutcome(name: string, input: unknown, content: unknown): ToolOutcome {
  const tool = browserAction(name);
  const batch = tool === "browser_batch";
  const { texts, context, images } = resultParts(content, batch);
  const page = context ? tabPage(context) : undefined;
  const extra = { ...(page ? { page } : {}), ...(images.length ? { images } : {}) };
  if (batch) {
    const actions = Array.isArray(obj(input).actions) ? (obj(input).actions as unknown[]) : [];
    // One "[name] result" or "[computer:action] result" text per action, in order.
    const results = texts.filter((t) => STEP.test(t)).map((t) => t.replace(STEP, "").trim());
    const steps = actions.map((a, i): BrowserStep => {
      const name = str(obj(a).name) ?? "";
      const result = results[i];
      const brief = result !== undefined ? actionBrief(name, result) : undefined;
      return { line: actionLine(name, obj(a).input, result !== undefined ? actionSummary(name, obj(a).input, result) : undefined), ...(brief ? { brief } : {}) };
    });
    return { status: "ok", steps, ...extra };
  }
  const text = texts.join("\n");
  const detail =
    tool === "javascript_tool"
      ? [fence(str(obj(input).text) ?? "", "js"), ...(text ? [fence(tailLines(text))] : [])].join("\n\n")
      : tool === "find" || tool === "read_console_messages" || tool === "read_network_requests"
        ? text
          ? fence(tailLines(text))
          : undefined
        : undefined;
  const brief = actionBrief(tool, text);
  return { status: "ok", summary: actionSummary(tool, input, text, context), ...(detail ? { detail } : {}), ...(brief ? { brief } : {}), ...extra };
}

/** "actions[2] (computer:screenshot) failed: Permission denied … (2 completed, 2 remaining)". */
const BATCH_FAILED = /^actions\[(\d+)\] \([\w:]+\) failed: (.*?)(?:\s*\(\d+ completed, \d+ remaining\))?$/m;

/**
 * The outcome of a browser_batch that stopped at an error: the actions that
 * ran with their results, the failed one with its error and the rest marked
 * as not run. Its text is the "[name] result" lines, then the failure.
 */
export function batchFailure(input: unknown, text: string): ToolOutcome {
  const actions = Array.isArray(obj(input).actions) ? (obj(input).actions as unknown[]) : [];
  const failed = BATCH_FAILED.exec(text);
  const at = failed ? Number(failed[1]) : -1;
  const error = escapeMd(cut((failed?.[2] ?? text.trim().split("\n").at(-1) ?? "").trim(), 100));
  const results = text.split("\n").filter((l) => STEP.test(l)).map((l) => l.replace(STEP, "").trim());
  const steps = actions.map((a, i): BrowserStep => {
    const name = str(obj(a).name) ?? "";
    const summary = i === at ? `✗ ${error}` : at >= 0 && i > at ? "not run" : results[i] !== undefined ? actionSummary(name, obj(a).input, results[i]) : undefined;
    return { line: actionLine(name, obj(a).input, summary) };
  });
  // Without the failure line the error goes below the actions.
  if (at < 0) steps.push({ line: `**✗** ${error}` });
  return { status: "error", summary: at >= 0 ? `✗ action ${at + 1} of ${actions.length} failed` : `✗ ${error}`, steps };
}

const tailLines = (text: string, n = 10) => text.trim().split("\n").slice(0, n).join("\n") + (text.trim().split("\n").length > n ? "\n…" : "");

/** Symbol and verb of the action an image of a browser call came from ("▣ screenshot", a batch's "↕ scroll"). */
export function imageAction(name: string, input: unknown, image: ResultImage | undefined): string {
  let tool = browserAction(name);
  let args = input;
  if (tool === "browser_batch" && image?.step !== undefined) {
    const action = obj((obj(input).actions as unknown[] | undefined)?.[image.step]);
    tool = str(action.name) ?? tool;
    args = action.input;
  }
  const { symbol, verb } = actionHead(tool, args);
  return `${symbol} ${verb}`;
}

/** The mark of screenshot `n` of a turn after its action; a click on it opens it, `o` lists them. */
export const shotMark = (n: number) => `\u001b[36m[▣ ${n}]\u001b[39m`;
/** Finds the screenshot marks in a rendered line, without colours: the number and the columns. */
export const SHOT_MARK = /\[▣ (\d+)\]/g;

/** The key that lists a turn's images, dimmed after the marks on screen (not when copying or exporting). */
export const SHOT_HINT = "\u001b[2m(o)\u001b[22m";

/** `line` with the marks of the screenshots numbered `shots`, and with `hint` the key that lists them. */
const withShots = (line: string, shots: number[] = [], hint = false) =>
  shots.length ? `${line} ${shots.map(shotMark).join(" ")}${hint ? ` ${SHOT_HINT}` : ""}` : line;

/** The screenshot numbers of a call's images that belong to batch action `step` (all of them for other calls). */
function shotsOf(outcome: ToolOutcome | undefined, shots: number[], step?: number): number[] {
  return (outcome?.images ?? []).flatMap((image, i) => (step === undefined || image.step === step ? [shots[i]] : [])).filter((n) => n !== undefined);
}

/**
 * A browser call at `level` (not "off"): its line, a batch's actions below it,
 * and details in full. `shots` numbers its images among the turn's screenshots.
 */
export function chromeMarkdown(name: string, input: unknown, outcome: ToolOutcome | undefined, level: ToolLevel, shots: number[] = [], hint = false): string {
  const tool = browserAction(name);
  const line = actionLine(tool, input, outcome?.summary);
  if (tool === "browser_batch") {
    const steps = outcome?.steps ?? batchSteps(input);
    return [line, ...steps.map((s, i) => `- ${withShots(s.line, shotsOf(outcome, shots, i), hint)}`)].join("\n");
  }
  const marked = withShots(line, shots, hint);
  return level === "full" && outcome?.detail ? `${marked}\n\n${outcome.detail}` : marked;
}

/** A batch's actions from its input, before or without a result. */
const batchSteps = (input: unknown): BrowserStep[] =>
  (Array.isArray(obj(input).actions) ? (obj(input).actions as unknown[]) : []).map((a) => ({ line: actionLine(str(obj(a).name) ?? "", obj(a).input) }));

const faint = (s: string) => `\u001b[2m${s}\u001b[22m`;

/** A list item of the browser frame: the line, then what it found, dimmed and indented below it. */
function frameItem(line: string, brief: string[] | undefined, shots: number[], hint: boolean): string {
  const below = (brief ?? []).map((l) => `  \n  ${faint(escapeMd(l))}`).join("");
  return `- ${withShots(line, shots, hint)}${below}`;
}

/**
 * A browser call as items of the frame the chat shows with tools off: one
 * per action (a batch's actions each), each with what it found below it.
 */
export function browserItems(name: string, input: unknown, outcome: ToolOutcome | undefined, shots: number[] = [], hint = false): string[] {
  const tool = browserAction(name);
  if (tool === "browser_batch") return (outcome?.steps ?? batchSteps(input)).map((s, i) => frameItem(s.line, s.brief, shotsOf(outcome, shots, i), hint));
  return [frameItem(actionLine(tool, input, outcome?.summary), outcome?.status === "ok" ? outcome.brief : undefined, shots, hint)];
}
