import { basename } from "node:path";
import { Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { renderMarkdown, stripBoxes } from "../render/markdown.js";
import { haystack } from "../filter.js";
import { attachmentFile, attachmentTitle, itemOfMark, markedPrompt, turnAttachments, type AttachmentItem } from "../attachments.js";
import { openInDefaultApp } from "../open.js";
import {
  AGENT_RUNNING_MARK,
  formatMs,
  formatTokens,
  agentStatusLine,
  agentTitle,
  subagentPromptLabel,
  turnMarkdown,
  turnScreenshots,
  type AgentRun,
  type Screenshot,
  type Attachment,
  type CompactInfo,
  type Continuation,
  type TaskNotification,
  type Turn,
  type WorkflowRun,
} from "../transcript/parse.js";
import { isBrowserTool, SHOT_HINT } from "../transcript/chrome.js";
import { fence, TOOL_LEVELS, type ToolLevel } from "../transcript/tools.js";
import { formatCount, shortModel } from "../transcript/turnStats.js";
import { displayPath } from "../transcript/sessions.js";
import {
  bold,
  dim,
  handleNavigation,
  List,
  flipOrder,
  orderFooter,
  previewHeader,
  rule,
  Screen,
  markFooter,
  markKeys,
  EntryText,
  Spinner,
  Star,
  makeScroll,
  truncate,
  type Layout,
} from "./layout.js";
import { bodyHeightBelow, headerRows, Preview } from "./Preview.js";
import { doubleClicks } from "./openKey.js";
import { useFocused } from "./focus.js";
import { useClipboard } from "./useClipboard.js";
import { AttachmentsDialog } from "./AttachmentsDialog.js";
import { useFavorites } from "./useFavorites.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { useSetting } from "./useSetting.js";
import { isRcViewer } from "../settings.js";
import { useSubagent, type Subagent } from "./useSubagent.js";
import type { Transcript } from "./useTranscript.js";

interface Props {
  cwd: string;
  /** Transcript of the session to show (resolved by App). */
  path?: string;
  /** The parsed session (read by App, shared with the plan view). */
  transcript: Transcript;
  layout: Layout;
  active: boolean;
  /** Reports whether the full-prompt view is open, so it can show over the whole pane. */
  onPromptOpen?: (open: boolean) => void;
  /** The viewer follows the running session, so its last unfinished turn is one Claude works on. */
  liveSession?: boolean;
  /** The filter dialog opened or closed. */
  onTyping?: (typing: boolean) => void;
  /** The screenshot dialog opened or closed: App ignores its keys meanwhile. */
  onModal?: (open: boolean) => void;
  /** The prompt line below has the keys (a remote viewer): the chat only scrolls, with PgUp/PgDn, as Claude Code's does. */
  scrollOnly?: boolean;
  /** The Remote Control Viewer's chat column has the keys: ↑↓ scroll the answer by line instead of switching turns. */
  previewKeys?: boolean;
  /** Space marks the selected turn; off in the Remote Control Viewer, where Space gives the prompt line the keys. */
  spaceMarks?: boolean;
}

/** t steps through the tool levels: off → compact → full → off. */
const nextToolLevel = (level: ToolLevel): ToolLevel => TOOL_LEVELS[(TOOL_LEVELS.indexOf(level) + 1) % TOOL_LEVELS.length];
const toolsFooter = (level: ToolLevel) => (level === "off" ? "t tools" : `t tools: ${level}`);

const red = (s: string) => `\u001b[31m${s}\u001b[39m`;

const magenta = (s: string) => `\u001b[35m${s}\u001b[39m`;
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** Where the running marks (⠿) of `lines` are, for the preview to spin them. */
export function spinnerMarks(lines: string[]): { line: number; col: number }[] {
  const marks: { line: number; col: number }[] = [];
  lines.forEach((line, i) => {
    const plain = stripAnsi(line);
    const at = plain.indexOf(AGENT_RUNNING_MARK);
    if (at >= 0) marks.push({ line: i, col: stringWidth(plain.slice(0, at)) });
  });
  return marks;
}

/**
 * The last line of the running turn's answer. With tool calls hidden, it counts them, so the user sees that Claude gets on.
 */
export function workingLine(turn: Turn, tools: ToolLevel): string {
  const calls = tools === "off" ? turn.blocks.filter((b) => b.kind === "tool").length : 0;
  const count = calls > 0 ? ` · ${calls} tool call${calls === 1 ? "" : "s"}` : "";
  return dim(`${AGENT_RUNNING_MARK} Claude is working…${count}`);
}

/**
 * The subagents a turn started, a workflow's agents included, or for a
 * notification the one it reports on (of a workflow, its agents).
 */
export function turnAgents(turn: Turn | undefined, all: AgentRun[], workflows: WorkflowRun[] = []): AgentRun[] {
  if (!turn) return [];
  if (turn.notification) {
    const id = turn.notification.toolUseId;
    return [...all.filter((a) => a.id === id), ...workflows.filter((w) => w.id === id).flatMap((w) => w.agents)];
  }
  return turn.blocks.flatMap((b) => (b.kind === "agent" ? [b.agent] : b.kind === "workflow" ? b.workflow.agents : []));
}

/** A turn started a workflow that has not ended yet. */
const workflowRunning = (turn: Turn) => turn.blocks.some((b) => b.kind === "workflow" && b.workflow.status === "running");

/** What a subagent was asked and did, read from its own transcript (or, without one, its task and result). */
function agentView(
  agent: AgentRun,
  sub: Subagent,
  place: { index: number; count: number },
  width: number,
  opts: { tools: ToolLevel; thinking: boolean; wrap: boolean; live: boolean },
): { header: string[]; lines: string[] } {
  const where = place.count > 1 ? ` · ${place.index + 1} of ${place.count}` : "";
  const full = previewHeader(agentTitle(agent), width, {
    marker: magenta("◆ "),
    style: (t) => `\u001b[1m${t}\u001b[22m`,
    // The header does not spin; the body's "is working…" line does.
    details: [agentStatusLine(agent).replace(AGENT_RUNNING_MARK, "▶") + where],
  });
  const header = [...full.slice(0, -1), rule(width, place.count > 1 ? "a/A agent · esc back" : "a/esc back")];
  const quote = (text: string) => text.split("\n").map((l) => `> ${l}`).join("\n");
  const parts: string[] = [];
  // Images and PDFs are numbered across the page, as `subagentAttachments` lists them.
  const shots = turnScreenshots({ blocks: sub.turns.flatMap((t) => t.blocks) });
  if (sub.turns.length > 0) {
    sub.turns.forEach((t, i) => {
      parts.push(`**${subagentPromptLabel(t, i)}**`, quote(t.prompt));
      const body = turnMarkdown(t, { tools: opts.tools, thinking: opts.thinking, agents: true, shots, shotHint: true });
      if (body) parts.push(body);
    });
  } else {
    if (agent.prompt) parts.push("**Task**", quote(agent.prompt));
    if (agent.result) parts.push("**Result**", agent.result);
  }
  const lines = parts.length ? renderMarkdown(parts.join("\n\n"), width, opts.wrap) : [];
  if (agent.status === "running" && opts.live) lines.push("", dim(`${AGENT_RUNNING_MARK} ${agent.type ?? "Agent"} is working…`));
  else if (!sub.file && agent.status !== "running") lines.push("", dim("(the subagent's own transcript was not found)"));
  return { header, lines };
}

/** What can be opened on a subagent's page: the images and PDFs of its tool results, numbered across the page. */
export function subagentAttachments(agent: AgentRun, sub: Subagent, cwd?: string): AttachmentItem[] {
  return turnAttachments({ id: agent.id, prompt: "", blocks: sub.turns.flatMap((t) => t.blocks) }, sub.file, cwd);
}

/** Images and PDFs of a turn: pasted into its prompt and returned by its tools (the list's `▣n`; @-mentions do not count). */
export function mediaCount(turn: Turn): number {
  const pasted = (turn.attachments ?? []).filter((a) => a.kind === "image").length;
  return turn.blocks.reduce((n, b) => n + (b.kind === "tool" ? (b.outcome?.images?.length ?? 0) : 0), pasted);
}

/** Colour of the ↩ of a notification by the task's status. */
const NOTIFICATION_COLOR: Record<string, string> = { completed: "green", failed: "red", killed: "red", stopped: "red" };

/** What ended a turn early, shown below its answer. */
function interruptLine(turn: Turn): string | undefined {
  if (turn.interrupted === "tool") return red("⊘ Interrupted by user during a tool call");
  if (turn.interrupted === "user") return red("⊘ Interrupted by user");
  return undefined;
}

const cyan = (s: string) => `\u001b[36m${s}\u001b[39m`;
const yellow = (s: string) => `\u001b[33m${s}\u001b[39m`;
const blue = (s: string) => `\u001b[34m${s}\u001b[39m`;
const shortId = (id: string) => id.slice(0, 8);
const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** A recap set apart from the answer: a heading and a bar down its left side. */
export function recapLines(text: string, width: number, wrap: boolean): string[] {
  const bar = yellow("▌ ");
  const body = renderMarkdown(text, Math.max(10, width - 2), wrap).map((l) => bar + `\u001b[3m${l}\u001b[23m`);
  return [bar + yellow(bold("※ Recap")), ...body];
}

/** A message from another agent, set apart from Claude's reaction below it: a heading and a bar down its left side. */
export function peerLines(n: TaskNotification, width: number, wrap: boolean): string[] {
  const bar = magenta("▌ ");
  const title = n.kind === "handback" ? "◆ Report" : "✉ Message";
  const body = renderMarkdown(n.result ?? "", Math.max(10, width - 2), wrap).map((l) => bar + l);
  return [bar + magenta(bold(title)) + (n.kind === "message" && n.from ? dim(` · from ${n.from}`) : ""), ...body];
}

/** "/compact · 217k → 10k tokens · 43 s": what a compaction reported. */
export function compactLine(info: CompactInfo): string {
  const sizes = info.preTokens !== undefined && info.postTokens !== undefined ? `${kTokens(info.preTokens)} → ${formatTokens(info.postTokens)}` : undefined;
  return [info.trigger === "auto" ? "compacted automatically" : "/compact", sizes, info.durationMs !== undefined ? formatMs(info.durationMs) : undefined]
    .filter(Boolean)
    .join(" · ");
}

/** The summary a compaction left: a heading with what it reported, then the summary. */
export function compactLines(text: string, info: CompactInfo | undefined, width: number, wrap: boolean): string[] {
  // No bar like the recap's: the summary is usually the whole answer, so there is nothing to set it apart from.
  return [blue(bold("⟳ Compact summary")) + (info ? dim(` · ${compactLine(info)}`) : ""), "", ...renderMarkdown(text, width, wrap)];
}

/**
 * The rendered answer of a turn. Recaps interrupt the Markdown, which is
 * rendered in runs between them, so each shows where Claude Code wrote it.
 */
export function answerLines(turn: Turn, opts: { tools: ToolLevel; thinking: boolean; agents: boolean }, width: number, wrap: boolean): string[] {
  const lines: string[] = [];
  const add = (part: string[]) => {
    if (part.length === 0) return;
    if (lines.length > 0) lines.push("");
    lines.push(...part);
  };
  // A report or message from another agent comes first; Claude's reaction to it follows.
  if (turn.notification?.kind && turn.notification.result) add(peerLines(turn.notification, width, wrap));
  // Screenshots are numbered across the whole turn, not per run.
  const shots = turnScreenshots(turn);
  let run: Turn["blocks"] = [];
  const flush = () => {
    const md = run.length ? turnMarkdown({ ...turn, blocks: run }, { ...opts, shots, shotHint: true }) : "";
    if (md) add(renderMarkdown(md, width, wrap));
    run = [];
  };
  for (const b of turn.blocks) {
    if (b.kind !== "recap" && b.kind !== "compact") {
      run.push(b);
      continue;
    }
    flush();
    add(b.kind === "recap" ? recapLines(b.text, width, wrap) : compactLines(b.text, b.info, width, wrap));
  }
  flush();
  return lines;
}

/** Columns moved per Ctrl+←/→ when lines are not wrapped. */
const HSCROLL_STEP = 8;

/** The name of the slash command a prompt runs ("/model" of "/model sonnet"); not a path such as /usr/bin. */
export function commandName(prompt: string): string | undefined {
  return /^\/[^\s/]+(?=\s|$)/.exec(prompt)?.[0];
}

/** Colour of a slash command's name, in the list and above the answer: Claude's orange, like the spinner. */
const COMMAND_COLOR = "#d97757";
const commandColor = (s: string) => `\u001b[38;2;217;119;87m${s}\u001b[39m`;

/** Longest prompt excerpt shown above the answer; Enter opens the full prompt. */
export const PROMPT_PREVIEW_CHARS = 1000;

/** Most rows of prompt text above the answer. */
export const PROMPT_PREVIEW_LINES = 5;

/**
 * Sticky prompt above the answer: at most PROMPT_PREVIEW_CHARS characters,
 * PROMPT_PREVIEW_LINES rows without its blank lines and half the preview
 * height. When cut, its last row ends in `…` and the rule points to the full prompt.
 */
export function promptHeader(
  prompt: string,
  width: number,
  height: number,
  attachments: Attachment[] = [],
  stats: string[] = [],
  shots: Screenshot[] = [],
): string[] {
  // Pasted images' placeholders in colour (a click opens one), those without one added.
  const marked = markedPrompt(prompt, attachments.filter((a) => a.kind === "image").length, true);
  const shortened = stripAnsi(marked).length > PROMPT_PREVIEW_CHARS ? sliceAnsi(marked, 0, PROMPT_PREVIEW_CHARS) + "…" : marked;
  // One row less for the prompt when the attachments line follows it.
  const summary = attachmentSummary(attachments, shots, true);
  // The stats always show; the prompt is cut first.
  const rows = Math.min(PROMPT_PREVIEW_LINES, headerRows(height - (summary ? 2 : 0) - statsRows(stats).length * 2) - 1);
  const wrapped = wrapAnsi(shortened, width - 2, { hard: true })
    .split("\n")
    .filter((l) => l.trim());
  const shown = wrapped.slice(0, rows);
  if (shown.length < wrapped.length) shown[rows - 1] = truncate(shown[rows - 1] + "…", width - 2);
  const text = shown.join("\n");
  // A slash command's name in colour, like in the list; it interrupts the dim of the rest.
  const name = commandName(text);
  const excerpt = name ? `\u001b[22m${commandColor(name)}\u001b[2m${text.slice(name.length)}` : text;
  const header = previewHeader(excerpt, width, { marker: cyan("❯ "), style: dim });
  const cut = shortened !== marked || shown.length < wrapped.length;
  return [
    ...header.slice(0, -1),
    ...(summary ? ["  " + dim(truncate(summary, width - 2))] : []),
    ...statsRows(stats),
    rule(width, cut || summary ? "↵ full prompt" : undefined),
  ];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const green = (s: string) => `\u001b[32m${s}\u001b[39m`;

/** The stats lines below a header, the first marked with `$` like the prompt with `❯`. */
function statsRows(stats: string[]): string[] {
  return stats.map((l, i) => (i === 0 ? cyan("$ ") : "  ") + l);
}

/** The parts that fit into `width` columns, joined by dim dots; the later ones are left out first. */
function fitParts(parts: string[], width: number): string {
  let line = "";
  for (const part of parts) {
    const next = line ? line + dim(" · ") + part : part;
    if (line && stringWidth(next) > width) break;
    line = next;
  }
  return line;
}

/**
 * The stats of a turn below its prompt: duration, output tokens, context,
 * models, tool calls and its subagents; then the files it created or changed
 * and their lines. `now` is set while the turn runs: its duration counts up.
 * None for a turn without a response from Claude.
 */
export function turnStatsLines(turn: Turn, agents: AgentRun[], width: number, now?: number): string[] {
  const s = turn.stats;
  if (!s) return [];
  const ms = turnDuration(turn, now);
  const models = Object.entries(s.models).sort((a, b) => b[1] - a[1]);
  const shown = models.some(([, n]) => n > 0) ? models.filter(([, n]) => n > 0) : models;
  const agentTokens = agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0);
  const parts = [
    ...(Number.isFinite(ms) && ms >= 0 ? [dim(formatMs(ms))] : []),
    ...(turn.interrupted ? [red("⊘ interrupted")] : []),
    ...(s.output > 0 ? [dim(`↓ ${formatCount(s.output)}`)] : []),
    ...(s.context > 0 ? [dim(`ctx ${formatCount(s.context)}`)] : []),
    ...(shown.length ? [dim(shown.map(([m]) => shortModel(m)).join(" + "))] : []),
    ...(s.tools > 0 ? [dim(plural(s.tools, "tool"))] : []),
    ...(agents.length > 0 && !turn.notification ? [dim(`+ ◆${agents.length}${agentTokens > 0 ? ` ${formatCount(agentTokens)}` : ""}`)] : []),
  ];
  const files = Object.values(s.files);
  const created = files.filter((f) => f === "new").length;
  const changed = files.length - created;
  const fileParts = files.length
    ? [
        dim("files ") + [...(created ? [green(`+${created}`)] : []), ...(changed ? [yellow(`~${changed}`)] : [])].join(" "),
        dim("lines ") + green(`+${s.added}`) + " " + red(`−${s.removed}`),
      ]
    : [];
  return [fitParts(parts, width), ...(fileParts.length ? [fitParts(fileParts, width)] : [])].filter((l) => l);
}

/** How long the turn took, or has been running for (`now`); NaN when unknown. */
function turnDuration(turn: Turn, now?: number): number {
  const s = turn.stats;
  const start = turn.timestamp ? Date.parse(turn.timestamp) : NaN;
  const end = now ?? (s?.end ? Date.parse(s.end) : NaN);
  return now === undefined && s?.durationMs !== undefined ? s.durationMs : end - start;
}

const dot = dim(" · ");

/**
 * The stats of a turn in full, below the full prompt: when it ran, the tokens
 * per model, the tool calls per name, each subagent and each file with its
 * lines. Empty groups are left out; none at all for a turn without stats.
 */
export function turnDetailLines(turn: Turn, agents: AgentRun[], width: number, cwd: string, now?: number): string[] {
  const s = turn.stats;
  if (!s) return [];
  const group = (title: string, summary = "") => ["", bold(title) + (summary ? "  " + summary : "")];

  const ms = turnDuration(turn, now);
  const span = turn.timestamp ? `${time(turn.timestamp)} – ${now !== undefined ? "running" : s.end ? time(s.end) : "?"}` : "";
  const when = [
    ...(span ? [span] : []),
    ...(Number.isFinite(ms) && ms >= 0 ? [formatMs(ms)] : []),
    ...(turn.interrupted ? [red("⊘ interrupted")] : []),
  ];

  const models = Object.entries(s.models)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const tokens = [
    ...(s.output > 0 ? [`↓ ${formatCount(s.output)}` + (models.length ? "  " + dim(models.map(([m, n]) => `${shortModel(m)} ${formatCount(n)}`).join(" · ")) : "")] : []),
    ...(s.context > 0 ? [`ctx ${formatCount(s.context)}`] : []),
  ];

  const tools = Object.entries(s.toolNames).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const shownAgents = turn.notification ? [] : agents;
  const agentTokens = shownAgents.reduce((sum, a) => sum + (a.tokens ?? 0), 0);

  const files = Object.entries(s.files)
    .map(([path, kind]) => ({ path: displayPath(path, cwd), kind, lines: s.lines[path] }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const created = files.filter((f) => f.kind === "new").length;
  const changed = files.length - created;
  const counts = (added: number, removed: number) => [...(added ? [green(`+${added}`)] : []), ...(removed ? [red(`−${removed}`)] : [])].join(" ");
  // The counts line up after the paths while they fit beside the longest one.
  const pathWidth = Math.max(0, ...files.map((f) => stringWidth(f.path)));
  const countsWidth = Math.max(0, ...files.map((f) => stringWidth(stripAnsi(f.lines ? counts(f.lines.added, f.lines.removed) : ""))));
  const aligned = 4 + pathWidth + 2 + countsWidth <= width;

  const lines = [
    ...(when.length ? [when.join(dot)] : []),
    ...(tokens.length ? [...group("Tokens"), ...tokens.map((l) => "  " + l)] : []),
    ...(tools.length ? [...group("Tools", dim(String(s.tools))), "  " + tools.map(([name, n]) => `${name} ${dim(String(n))}`).join(dot)] : []),
    ...(shownAgents.length
      ? [
          ...group("Agents", dim([String(shownAgents.length), ...(agentTokens > 0 ? [formatCount(agentTokens)] : [])].join(" · "))),
          ...shownAgents.flatMap((a) => [`  ◆ ${a.type ?? "agent"} ${dim(`"${a.description}"`)}`, "    " + dim(agentStatusLine(a))]),
        ]
      : []),
    ...(files.length
      ? [
          ...group(
            "Files",
            [...(created ? [green(`+${created}`)] : []), ...(changed ? [yellow(`~${changed}`)] : [])].join(" ") + dot + green(`+${s.added}`) + " " + red(`−${s.removed}`),
          ),
          ...files.map((f) => {
            const mark = f.kind === "new" ? green("+") : yellow("~");
            const n = f.lines ? counts(f.lines.added, f.lines.removed) : "";
            const gap = aligned ? " ".repeat(pathWidth - stringWidth(f.path) + 2) : "  ";
            return `  ${mark} ${f.path}${n ? gap + n : ""}`;
          }),
        ]
      : []),
  ];
  return [
    cyan("$ ") + bold("Details"),
    rule(width),
    ...lines.flatMap((l) => wrapAnsi(l, width, { hard: true, trim: false }).split("\n")),
  ];
}

/**
 * One line naming what came with the prompt and what the turn's tools
 * returned: "📎 2 pasted images · @src/Order.cs · 12 lines selected in Foo.cs
 * · 1 tool image · 3 screenshots · 1 PDF", with `hint` the key that lists them.
 */
export function attachmentSummary(attachments: Attachment[], shots: Screenshot[] = [], hint = false): string | undefined {
  const images = attachments.filter((a) => a.kind === "image").length;
  const count = (kind: "image" | "pdf", browser: boolean) => shots.filter((s) => s.kind === kind && isBrowserTool(s.block.name) === browser).length;
  const tool = count("image", false);
  const screenshots = count("image", true);
  const pdfs = shots.filter((s) => s.kind === "pdf").length;
  const parts = [
    ...(images > 0 ? [plural(images, "pasted image")] : []),
    ...attachments.filter((a) => a.kind !== "image").map(attachmentName),
    ...(tool > 0 ? [plural(tool, "tool image")] : []),
    ...(screenshots > 0 ? [plural(screenshots, "screenshot")] : []),
    ...(pdfs > 0 ? [plural(pdfs, "PDF")] : []),
  ];
  if (parts.length === 0) return undefined;
  const openable = images > 0 || shots.length > 0 || attachments.some((a) => a.kind === "file" || a.kind === "directory");
  return "📎 " + parts.join(" · ") + (hint && openable ? " " + SHOT_HINT : "");
}

function attachmentName(a: Attachment): string {
  switch (a.kind) {
    case "image":
      return "image";
    case "file":
      return "@" + a.path.replace(/\\/g, "/");
    case "directory":
      return "@" + a.path.replace(/\\/g, "/").replace(/\/?$/, "/");
    case "selection": {
      const lines = a.lines !== undefined ? plural(a.lines, "line") : "lines";
      return `${lines} selected${a.file ? ` in ${a.file.replace(/\\/g, "/")}` : ""}`;
    }
  }
}

/**
 * The attachments listed below the full prompt: pasted images with where
 * their file is, @-mentions and selections, then the images and PDFs the
 * turn's tools returned.
 */
function attachmentLines(turn: Turn, cwd: string): string[] {
  const attachments = turn.attachments ?? [];
  const items = turnAttachments(turn, undefined, cwd);
  const pasted = items.filter((i) => i.kind === "pasted");
  let image = 0;
  const lines = [
    ...attachments.map((a) => {
      if (a.kind !== "image") return "  " + attachmentName(a);
      const n = pasted[image++]?.n;
      return `  ${cyan(`[Image #${n}]`)}  ${dim(a.path ? displayPath(a.path, cwd) : "(only in the transcript)")}`;
    }),
    ...items.flatMap((i) => (i.kind === "image" || i.kind === "pdf" ? [`  ${cyan(`[${i.kind === "pdf" ? "▤" : "▣"} ${i.n}]`)}  ${i.label}`] : [])),
  ];
  if (lines.length === 0) return [];
  const hint = items.length ? [dim("  o opens the attachments, a click on a mark opens it")] : [];
  return ["", "\u001b[1m📎 Attachments\u001b[22m", ...lines, ...hint];
}

/** What is known about where the session went on: the ids, the compaction, the background, how to resume it. */
export function continuationDetails(c: Continuation): string[] {
  const compact = c.compact;
  return [
    `session ${c.fromSessionId ? shortId(c.fromSessionId) : "(earlier, not found)"} → ${c.sessionId ? shortId(c.sessionId) : "?"}`,
    ...(compact ? [compactLine(compact)] : []),
    ...(c.backgrounded ? ["sent to the background, run by the Claude Code daemon"] : []),
    ...(c.sessionId ? [`claude --resume ${c.sessionId}`] : []),
  ];
}

/** Header of a continuation entry: what happened, then its details; Claude's answers after it follow below. */
export function continuationHeader(title: string, c: Continuation, width: number, stats: string[] = []): string[] {
  return [...previewHeader(title, width, { marker: blue("⤷ "), style: bold, details: continuationDetails(c) }).slice(0, -1), ...statsRows(stats), rule(width)];
}

/** "8 agents · 7 done · 1 failed": how a workflow's agents went, as its notification counts them. */
export function agentCounts(a: NonNullable<TaskNotification["agents"]>): string {
  return [
    plural(a.count, "agent"),
    ...(a.done !== undefined && a.done !== a.count ? [`${a.done} done`] : []),
    ...(a.failed ? [`${a.failed} failed`] : []),
    ...(a.skipped ? [`${a.skipped} skipped`] : []),
  ].join(" · ");
}

/** Claude Code's note at the end of a result it cut: "... (truncated 80278 chars, full result in …)". */
const TRUNCATED = /\n?\.\.\. \(truncated [^)]*\)\s*$/;

/**
 * A task's result for the full prompt: JSON (a workflow's, possibly cut by
 * Claude Code) as a code block, the note about the cut below it; else Markdown.
 */
export function notificationResult(result: string): string {
  const text = result.trim();
  if (!/^[[{]/.test(text)) return text;
  const cut = TRUNCATED.exec(text);
  const json = cut ? text.slice(0, cut.index) : text;
  return fence(indentJson(json), "json") + (cut ? `\n\n*${cut[0].trim().replace(/^\.\.\. \(|\)$/g, "").replace(/, full result in .*$/, "")}*` : "");
}

/**
 * JSON spread over lines and indented by two per level, like `JSON.stringify(…, null, 2)`,
 * but also for JSON cut off in the middle, which cannot be parsed.
 */
export function indentJson(json: string): string {
  let out = "";
  let depth = 0;
  let inString = false;
  const newline = () => "\n" + "  ".repeat(Math.max(0, depth));
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inString) {
      out += c;
      if (c === "\\") out += json[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (/\s/.test(c)) continue;
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      // An empty object or array stays on its line.
      if (json.slice(i + 1).trimStart().startsWith(close)) {
        out += c + close;
        i = json.indexOf(close, i + 1);
        continue;
      }
      depth++;
      out += c + newline();
    } else if (c === "}" || c === "]") {
      depth--;
      out += newline() + c;
    } else if (c === ",") {
      out += c + newline();
    } else if (c === ":") {
      out += ": ";
    } else {
      out += c;
    }
  }
  return out;
}

/** The complete prompt, shown instead of the answer after Enter. */
function fullPrompt(turn: Turn, width: number, cwd: string): { header: string[]; lines: string[] } {
  if (turn.continuation) {
    return {
      header: [blue("⤷ ") + bold("Session continued") + dim(" · ↵/esc back to answer"), rule(width)],
      lines: [turn.prompt, "", ...continuationDetails(turn.continuation)].flatMap((l) => wrapAnsi(l, width, { hard: true }).split("\n")),
    };
  }
  const n = turn.notification;
  // A notification's "prompt" is its summary; what the task returned comes below it.
  const usage = n
    ? [
        ...(n.durationMs !== undefined ? [formatMs(n.durationMs)] : []),
        ...(n.agents ? [agentCounts(n.agents)] : []),
        ...(n.toolUses !== undefined ? [plural(n.toolUses, "tool use")] : []),
        ...(n.tokens !== undefined ? [formatTokens(n.tokens)] : []),
      ].join(" · ")
    : "";
  const result = n
    ? [
        "",
        dim(`${n.status}${usage ? ` · ${usage}` : ""}`),
        ...(n.result ? ["", ...renderMarkdown(notificationResult(n.result), width)] : []),
        ...(n.outputFile && n.result && TRUNCATED.test(n.result) ? ["", dim("full result: ") + displayPath(n.outputFile, cwd)] : []),
      ]
    : [];
  return {
    header: [cyan("❯ ") + `\u001b[1m${n?.kind === "handback" ? "Agent report" : n?.kind === "message" ? "Message" : n ? "Task notification" : "Prompt"}\u001b[22m` + dim(" · ↵/esc back to answer"), rule(width)],
    lines: [
      ...wrapAnsi(markedPrompt(turn.prompt, (turn.attachments ?? []).filter((a) => a.kind === "image").length, true), width, { hard: true, trim: false }).split("\n"),
      ...result,
      ...attachmentLines(turn, cwd).flatMap((l) => wrapAnsi(l, width, { hard: true, trim: false }).split("\n")),
    ],
  };
}

function time(ts?: string): string {
  if (!ts) return "     ";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ChatView({ cwd, path, transcript, layout, active, onPromptOpen, liveSession = false, onTyping, onModal, scrollOnly = false, previewKeys = false, spaceMarks = true }: Props) {
  const { turns, version } = transcript;
  const copy = useClipboard();
  const { listWidth, previewWidth, bodyHeight, headerHeight = bodyHeight, listHeight = bodyHeight } = layout;

  const [selected, setSelected] = useState(0);
  const [follow, setFollow] = useState(true);
  const [showTools, setShowTools] = useSetting("showTools");
  const [showThinking, setShowThinking] = useSetting("showThinking");
  const [wrap, setWrap] = useSetting("chatWrap");
  const [showAgents] = useSetting("showAgents");
  // Turns are kept oldest first; newest first only mirrors the list and its keys.
  const [order, setOrder] = useSetting("chatOrder");
  const reversed = order === "newest-first";
  // The subagent shown instead of the answer (a), by its place among the turn's agents.
  const [agentIndex, setAgentIndex] = useState<number>();
  const [agentPos, setAgentPos] = useState(0);
  const focused = useFocused();
  const [isDoubleClick] = useState(() => doubleClicks());
  const [hscroll, setHscroll] = useState(0);
  const [flash, setFlash] = useState<string>();
  const [promptOpen, setPromptOpen] = useState(false);
  // Marked (favourite) turns of the project; they carry over into continued sessions.
  const favorites = useFavorites(cwd, "turns", path);
  const markedCount = turns.filter((t) => favorites.isMarked(t.id)).length;

  // Each turn remembers where its answer was scrolled to, also across restarts; unvisited turns start at the top.
  // The selection is kept per session: a viewer of another session of the project must not move this one's.
  const remembered = usePositions(cwd, "chat", path ? basename(path, ".jsonl") : undefined);
  // A turn is found by its prompt; its details are what came with it and the subagents it started.
  const filter = useListFilter({
    items: turns,
    text: (t) => ({
      list: t.prompt,
      details: haystack([...(t.attachments ?? []).map(attachmentName), ...turnAgents(t, transcript.agents, transcript.workflows).map((a) => a.description)]),
    }),
    deps: [version],
    selected,
    select: (i) => select(i),
    reversed,
    layout,
    onTyping,
    marked: (t) => favorites.isMarked(t.id),
    restoreCopy: remembered.follow === false && remembered.pinned ? (t) => t.id === remembered.selected : undefined,
  });
  // The newest turn shown: following and End go there, also while a filter is on.
  const last = filter.last;
  const newest = turns.length - 1;
  const current = filter.none ? undefined : turns[Math.min(selected, Math.max(0, newest))];
  // Claude works on the last turn until it is done or interrupted.
  const isRunning = (t: Turn | undefined) => liveSession && t !== undefined && t === turns[newest] && !t.done && !t.interrupted;
  const agentsOf = (t: Turn | undefined) => turnAgents(t, transcript.agents, transcript.workflows);
  // Background agents and workflows keep running after their turn ended.
  const agentsRunning = (t: Turn) => liveSession && !t.notification && (agentsOf(t).some((a) => a.status === "running") || workflowRunning(t));
  const currentAgents = agentsOf(current);
  const agent = agentIndex !== undefined ? currentAgents[agentIndex] : undefined;
  const subagent = useSubagent(agent?.transcript ?? path, agent);

  // While the turn runs, its duration counts up every second.
  const running = isRunning(current);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const stats = current ? turnStatsLines(current, currentAgents, previewWidth - 2, running ? now : undefined) : [];
  const statsKey = stats.join("\n");
  const answerHeader = useMemo(() => {
    if (!current) return [];
    if (current.continuation) return continuationHeader(current.prompt, current.continuation, previewWidth, stats);
    if (current.compacted) return [...previewHeader(current.prompt, previewWidth, { marker: blue("⟳ "), style: bold }).slice(0, -1), ...statsRows(stats), rule(previewWidth)];
    return promptHeader(current.prompt, previewWidth, headerHeight, current.attachments, stats, turnScreenshots(current));
  }, [current, version, previewWidth, headerHeight, statsKey]);
  const answerBody = useMemo(() => {
    if (!current) return [];
    const body = answerLines(current, { tools: showTools, thinking: showThinking, agents: showAgents }, previewWidth, wrap);
    const status = isRunning(current) ? workingLine(current, showTools) : interruptLine(current);
    const lines = body.length ? body : status ? [] : [dim("(no text output yet)")];
    return status ? [...lines, ...(lines.length ? [""] : []), status] : lines;
  }, [current, version, previewWidth, showTools, showThinking, showAgents, wrap, liveSession]);
  const answer = useMemo(() => ({ header: answerHeader, lines: answerBody }), [answerHeader, answerBody]);
  const promptPage = useMemo(
    () => (current && promptOpen ? fullPrompt(current, previewWidth, cwd) : undefined),
    [current, version, promptOpen, previewWidth, cwd],
  );
  // The details below it count up while the turn runs; the prompt above stays as rendered.
  const details = current && promptOpen ? turnDetailLines(current, currentAgents, previewWidth, cwd, running ? now : undefined) : [];
  const detailsKey = details.join("\n");
  const prompt = useMemo(
    () => promptPage && (details.length ? { header: promptPage.header, lines: [...promptPage.lines, "", ...details] } : promptPage),
    [promptPage, detailsKey],
  );
  const agentPage = useMemo(
    () =>
      agent && agentIndex !== undefined
        ? agentView(agent, subagent, { index: agentIndex, count: currentAgents.length }, previewWidth, {
            tools: showTools,
            thinking: showThinking,
            wrap: true,
            live: liveSession,
          })
        : undefined,
    [agent, agentIndex, currentAgents.length, subagent.version, subagent.file, version, previewWidth, showTools, showThinking, liveSession],
  );
  const { header, lines } = agentPage ?? prompt ?? answer;
  const detailOpen = promptOpen || agentPage !== undefined;
  // Running agents spin in the answer (and in an agent's page), like "Claude is working…".
  const spinners = useMemo(() => (liveSession ? spinnerMarks(lines) : []), [lines, liveSession]);

  // The session whose remembered selection was restored (or found to be missing); nothing is stored before.
  const restoredFor = useRef<string | undefined>(undefined);
  const justRestored = useRef(false);
  // The selection stored for a turn this session does not have (see the restore below).
  const unrestored = useRef<string | undefined>(undefined);
  const [pos, setPos] = useState(0);
  const [promptPos, setPromptPos] = useState(0);

  const live = follow && selected === last;
  const base = bodyHeightBelow(header, bodyHeight);
  const viewport = base;
  const scroll = agentPage
    ? makeScroll(agentPos, setAgentPos, lines.length, viewport)
    : promptOpen
    ? makeScroll(promptPos, setPromptPos, lines.length, viewport)
    : makeScroll(pos, setPos, lines.length, viewport);

  // How far unwrapped answer lines can be shifted until the longest one ends at the right edge.
  // The full prompt is always wrapped.
  const maxHscroll = useMemo(
    () => (wrap || detailOpen ? 0 : Math.max(0, ...answer.lines.map((l) => stringWidth(l))) - previewWidth),
    [answer, wrap, detailOpen, previewWidth],
  );
  const shift = (delta: number) => setHscroll((h) => Math.max(0, Math.min(maxHscroll, h + delta)));

  const togglePrompt = (open: boolean) => {
    setPromptOpen(open);
    setAgentIndex(undefined);
    onPromptOpen?.(open);
    setPromptPos(0);
  };
  /** Shows the turn's subagent at `index` instead of the answer; undefined goes back. */
  const showAgent = (index: number | undefined) => {
    setAgentIndex(index);
    setAgentPos(0);
    setPromptOpen(false);
    onPromptOpen?.(index !== undefined);
    // Stay on this turn while reading about its agents.
    if (index !== undefined) setFollow(false);
  };

  /** Switches to another turn, keeping the position of the one being left. */
  const showTurn = (index: number) => {
    // Before the session's turns were restored, `current` is just the initial first turn, not a place the user left.
    if (current && restoredFor.current === path) remembered.set(current.id, detailOpen ? pos : Math.min(pos, scroll.max));
    if (agentIndex !== undefined) {
      setAgentIndex(undefined);
      onPromptOpen?.(promptOpen);
    }
    setSelected(index);
    setPos(remembered.get(turns[index]?.id));
    setHscroll(0);
  };

  // A new session: reset the view. Its turns can come in the same render (a session continued from
  // other transcripts is read at once), so the effects below run after this one and settle the selection.
  useEffect(() => {
    setSelected(0);
    setPos(0);
    setFollow(true);
  }, [path]);

  // Following: select the newest turn, also of a session just switched to (then `selected` is the old session's).
  useEffect(() => {
    if (follow && last >= 0) showTurn(last);
  }, [follow, last, path]);

  // Following: stick to the bottom of the latest answer while it grows.
  useEffect(() => {
    if (live && !detailOpen) setPos(scroll.max);
  }, [live, detailOpen, scroll.max]);

  /** Ctrl+End: the bottom of this answer; for the latest turn also resume following. */
  const jumpToTop = () => {
    if (!detailOpen && selected === last && follow) setFollow(false);
    scroll.set(0);
  };
  const jumpToBottom = () => {
    if (detailOpen) return scroll.set(scroll.max);
    if (selected === last) setFollow(true);
    else setPos(Math.max(0, lines.length - base));
  };

  // Once the turns of a session are there: back to the turn selected last time, unless the newest was followed.
  useEffect(() => {
    if (!path || restoredFor.current === path || turns.length === 0) return;
    restoredFor.current = path;
    const at = remembered.follow === false ? turns.findIndex((t) => t.id === remembered.selected) : -1;
    // A turn of another session, e.g. the one /resume brings back: kept while this one is only followed.
    unrestored.current = at < 0 && remembered.follow === false ? remembered.selected : undefined;
    if (at < 0) return;
    justRestored.current = true;
    setFollow(false);
    setSelected(at);
    setPos(remembered.get(turns[at].id));
  }, [path, turns.length]);

  // Keep the selection and this turn's position (the full prompt has its own, not kept).
  useEffect(() => {
    if (restoredFor.current !== path || justRestored.current) {
      justRestored.current = false;
      return;
    }
    if (!current) return;
    if (live && unrestored.current) return;
    unrestored.current = undefined;
    remembered.select(current.id, live, filter.copySelected);
    if (!detailOpen) remembered.set(current.id, pos);
  }, [current?.id, live, pos, detailOpen, filter.copySelected]);

  const select = (index: number) => {
    if (last < 0) return;
    // The user chose: from now on their selection is the one kept.
    unrestored.current = undefined;
    const next = Math.max(0, Math.min(last, index));
    if (next !== selected) showTurn(next);
    setFollow(next === last);
  };
  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(undefined), 2000);
  };
  // What can be opened: the turn's pasted images, @-mentions and the images and PDFs of its tools,
  // numbered as the prompt and the answer mark them; on a subagent's page, that page's.
  const turnItems = useMemo(() => (current ? turnAttachments(current, path, cwd) : []), [current, version, path, cwd]);
  const agentItems = useMemo(() => (agent ? subagentAttachments(agent, subagent, cwd) : []), [agent, subagent.version, subagent.file, cwd]);
  const items = agentPage ? agentItems : turnItems;
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  useEffect(() => onModal?.(attachmentsOpen), [attachmentsOpen]);
  /** Opens `item` in its default app. */
  const openItem = (item: AttachmentItem | undefined) => {
    if (!item) return;
    let file: string | undefined;
    try {
      file = attachmentFile(item);
    } catch (err) {
      return notify(`could not read ${attachmentTitle(item)}: ${(err as Error).message}`);
    }
    if (!file) return notify(`${attachmentTitle(item)} is no longer available`);
    openInDefaultApp(file);
    notify(`opened ${attachmentTitle(item)}`);
  };
  /** Mouse wheel over the answer: like Ctrl+↑/↓, scrolling up leaves the live end and scrolling back down rejoins it. */
  const wheel = (delta: number) => {
    if (!detailOpen && selected === last) {
      if (delta < 0 && follow) setFollow(false);
      if (delta > 0 && scroll.scroll + delta >= scroll.max) setFollow(true);
    }
    scroll.by(delta);
  };
  /** Selects the next or previous marked turn. */
  const jumpMark = (dir: 1 | -1) => {
    const target = filter.nextMark(dir);
    if (target !== undefined) select(target);
  };

  useInput(
    (input, key) => {
      // While the prompt line has the keys, only paging reaches the chat.
      if (scrollOnly && !key.pageUp && !key.pageDown) return;
      if (filter.handleKey(input, key)) return;
      // The Remote Control Viewer's chat column: ↑↓ scroll like the wheel, leaving and rejoining the live end.
      if (previewKeys && (key.upArrow || key.downArrow) && !key.ctrl && !key.shift && !key.meta) return wheel(key.upArrow ? -1 : 1);
      // a / A step through the turn's subagents and, past the last / first, back to the answer.
      if (input === "a" || input === "A") {
        if (currentAgents.length === 0) return notify("no subagents in this turn");
        const next = agentIndex === undefined ? (input === "a" ? 0 : currentAgents.length - 1) : agentIndex + (input === "a" ? 1 : -1);
        return showAgent(next >= 0 && next < currentAgents.length ? next : undefined);
      }
      if (agentPage) {
        // ↑↓ and the list switch turns, which closes the page like Esc.
        if (key.escape) return showAgent(undefined);
        if (key.ctrl && key.end) return scroll.set(scroll.max);
      }
      if (key.ctrl && key.end) return jumpToBottom();
      // Checked first because plain ↑/↓ switch turns.
      const mark = !spaceMarks && input === " " ? undefined : markKeys(input, key);
      if (mark === "toggle") {
        if (!current) return;
        if (favorites.isMarked(current.id)) filter.unmarking(selected);
        return favorites.toggle(current.id);
      }
      if (mark) return jumpMark(mark);
      if (key.ctrl && (key.leftArrow || key.rightArrow)) return shift(key.leftArrow ? -HSCROLL_STEP : HSCROLL_STEP);
      if (input === "w") {
        setWrap((w) => !w);
        return setHscroll(0);
      }
      const page = viewport - 2;
      if (!detailOpen && selected === last) {
        // Scrolling up leaves the live end; scrolling back to the bottom rejoins it.
        const up = key.pageUp || (key.ctrl && (key.upArrow || key.home));
        const down = key.ctrl && key.downArrow ? 1 : key.pageDown ? page : 0;
        if (up && follow) setFollow(false);
        if (down && scroll.scroll + down >= scroll.max) setFollow(true);
      }
      const nav = { ...filter.nav, scroll, page };
      if (handleNavigation(input, key, nav)) return;
      if (key.return && current) return togglePrompt(!promptOpen);
      if (key.escape && promptOpen) return togglePrompt(false);
      if (input === "f") {
        if (follow) setFollow(false);
        else select(last);
        return notify(follow ? "follow off" : "follow on");
      }
      if (input === "s") return setOrder(flipOrder);
      // o lists what came with the prompt and what the turn's tools returned, to open one.
      if (input === "o") return items.length ? setAttachmentsOpen(true) : notify(agentPage ? "no images on this page" : "no attachments in this turn");
      if (input === "t") return setShowTools(nextToolLevel);
      if (input === "h") return setShowThinking((v) => !v);
      if (input === "c" && current) {
        const md = stripBoxes(turnMarkdown(current, { tools: "off", thinking: false, browser: false }));
        copy(md).then(
          () => notify("copied Markdown to clipboard"),
          (err: Error) => notify(`copy failed: ${err.message}`),
        );
      }
    },
    { isActive: active && !filter.open && !attachmentsOpen },
  );

  const session = path ? basename(path, ".jsonl").slice(0, 8) : "none";

  return (
    <>
    <Screen
      layout={layout}
      mode="chat"
      status={
        // Full brightness on the focused (blue) bar, dimmed otherwise.
        <Text dimColor={!focused}>
          session {session} · {filter.count(turns.length)} turns · {scroll.position}
          {markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
          {/* Options (follow, tools, thinking, wrap) show as highlighted keys in the help line, not here. */}
          {!wrap && hscroll > 0 && ` · → ${Math.min(hscroll, maxHscroll)} cols`}
        </Text>
      }
      list={
        <List
            reversed={reversed}
            onPick={select}
            centre={restoredFor.current}
          // A double click does what Enter does.
          onClick={(i) => isDoubleClick(i) && i === selected && current && togglePrompt(!promptOpen)}
          items={turns}
          shown={filter.shown}
          pinned={filter.pinned}
          filter={filter.banner}
          selected={selected}
          height={listHeight}
          empty={filter.empty ?? "Waiting for prompts…"}
          itemKey={(t, i) => t.id + i}
          time={(t) => t.timestamp}
          render={(t, isSelected) => {
            const marked = favorites.isMarked(t.id);
            // Claude works on it, or subagents it started still run.
            const running = isRunning(t) || agentsRunning(t);
            const agentCount = t.notification ? 0 : agentsOf(t).length;
            const badge = agentCount > 0 ? `◆${agentCount} ` : "";
            const media = mediaCount(t);
            const mediaBadge = media > 0 ? `▣${media} ` : "";
            // Slash commands stand out, like above the answer.
            const command = t.notification || t.continuation || t.compacted ? undefined : commandName(t.prompt);
            return (
              <>
                {marked && <Star />}
                {/* The turn Claude works on spins; one the user stopped shows ⊘. */}
                {running && (
                  <>
                    <Spinner active={active} />{" "}
                  </>
                )}
                {t.interrupted && <Text color="red">⊘ </Text>}
                <Text dimColor={!isSelected}>{time(t.timestamp)} </Text>
                {/* ↳ marks prompts sent while Claude was still working, ↩ a background task reporting back. */}
                {t.queued && <Text color="cyan">↳ </Text>}
                {t.notification && (
                  // Magenta like the report in the answer for a message from an agent, else by the task's status.
                  <Text color={t.notification.kind ? "magenta" : (NOTIFICATION_COLOR[t.notification.status] ?? "yellow")}>↩ </Text>
                )}
                {t.continuation && <Text color="blue">⤷ </Text>}
                {t.compacted && <Text color="blue">⟳ </Text>}
                {badge && <Text color="magenta">{badge}</Text>}
                {mediaBadge && <Text color="cyan">{mediaBadge}</Text>}
                <EntryText
                  text={t.prompt}
                  lead={command ? { columns: stringWidth(command), color: COMMAND_COLOR } : undefined}
                  width={Math.max(
                    4,
                    listWidth -
                      7 -
                      (t.queued || t.notification || t.continuation || t.compacted ? 2 : 0) -
                      (marked ? 2 : 0) -
                      (running || t.interrupted ? 2 : 0) -
                      badge.length -
                      mediaBadge.length,
                  )}
                  selected={isSelected}
                  active={active}
                />
              </>
            );
          }}
        />
      }
      preview={
        path ? (
          <Preview
            onWheel={wheel}
            onLink={(url) => notify(`opened ${url}`)}
            // A click on a mark opens what it names: in the prompt, the answer or a subagent's page.
            onMark={(mark) => openItem(itemOfMark(items, mark))}
            header={header}
            lines={lines}
            scroll={scroll.scroll}
            width={previewWidth}
            height={bodyHeight}
            hscroll={Math.min(hscroll, maxHscroll)}
            onJump={(to) => (to === "end" ? jumpToBottom() : jumpToTop())}
            // The "Claude is working…" line ends the answer of the running turn.
            spinner={spinners.length ? { at: spinners, active } : undefined}
          />
        ) : (
          <Text dimColor>No Claude Code session found for {cwd}</Text>
        )
      }
      footer={
        flash ??
        (agentPage ? [
          { text: "↑↓ turn", priority: 4 },
          { text: "PgUp/Dn scroll", priority: 1 },
          { text: currentAgents.length > 1 ? "a/A agent" : "a agent", on: true },
          { text: toolsFooter(showTools), on: showTools !== "off", priority: 2 },
          { text: "h think", on: showThinking, priority: 2 },
        ] : [
          { text: previewKeys ? "↑↓ scroll" : "↑↓ turn", priority: 4 },
          { text: "PgUp/Dn scroll", priority: 1 },
          ...(wrap ? [] : [{ text: "^←→ side", priority: 4 }]),
          // On a remote session's last turn, Enter sends to it.
          { text: "↵ prompt", on: promptOpen },
          { text: "f follow", on: follow },
          ...filter.footer,
          orderFooter(order, "oldest-first"),
          ...markFooter(favorites.isMarked(current?.id), markedCount).filter((f) => spaceMarks || f.text !== "␣ mark"),
          { text: toolsFooter(showTools), on: showTools !== "off", priority: 2 },
          { text: "h think", on: showThinking, priority: 2 },
          { text: "w wrap", on: wrap, priority: 2 },
          { text: "c copy", priority: 2 },
          ...(items.length > 0 ? [{ text: `o ${plural(items.length, "attachment")}`, priority: 3 }] : []),
          ...(currentAgents.length > 0 ? [{ text: `a ${plural(currentAgents.length, "agent")}`, priority: 3 }] : []),
          { text: isRcViewer() ? "1/2 view" : "1-6/tab view", priority: 1 },
        ])
      }
    />
    {filter.dialog}
    {attachmentsOpen && active && (
      <AttachmentsDialog layout={layout} items={items} onOpen={openItem} onClose={() => setAttachmentsOpen(false)} />
    )}
    </>
  );
}
