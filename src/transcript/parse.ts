import { BOX_END, BOX_START_CYAN } from "../render/markdown.js";
import { browserItems, browserTitle, isBrowserTool, navigates } from "./chrome.js";
import { escapeMd, fence, toolMarkdown, toolOutcome, type ToolLevel, type ToolOutcome } from "./tools.js";
import { addFileChange, emptyStats, usageCounts, type TurnStats } from "./turnStats.js";

/** A tool call; `outcome` is set once its result arrives (Claude Code writes the call only then). */
export interface ToolBlock {
  kind: "tool";
  id?: string;
  name: string;
  input: unknown;
  /** The session's folder when the call was made, for short paths. */
  cwd?: string;
  outcome?: ToolOutcome;
}

/** One block of assistant output, in transcript order. */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | ToolBlock
  | { kind: "agent"; agent: AgentRun }
  /** Claude Code's recap of the session when the user comes back after a while (an `away_summary` entry). */
  | { kind: "recap"; text: string }
  /** The summary Claude Code compacted the conversation into, with what the compaction reported. */
  | { kind: "compact"; text: string; info?: CompactInfo };

/** "running" until the tool result (foreground) or the task notification (background) says otherwise. */
export type AgentStatus = "running" | "completed" | "failed" | "killed";

/**
 * A subagent Claude started with the Agent tool. Updated in place as its
 * result and notifications arrive, so blocks and lists that hold it see the
 * current state.
 */
export interface AgentRun {
  /** The Agent tool call id; the result, notifications and the subagent's meta.json refer to it. */
  id: string;
  description: string;
  /** subagent_type, e.g. "Explore". */
  type?: string;
  model?: string;
  /** Runs in the background: the tool returns at once and a notification reports the end. */
  background?: boolean;
  /** The task given to the subagent. */
  prompt?: string;
  status: AgentStatus;
  /** Names the subagent's transcript, `subagents/agent-<agentId>.jsonl`. */
  agentId?: string;
  /** The subagent's final report. */
  result?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  started?: string;
  /** The transcript the call is in, when a session spans several (`continuedIn`); its subagents are next to it. */
  transcript?: string;
}

/**
 * A `<task-notification>`: a background agent or command stopped. Or, with
 * `kind`, a message from another agent: a subagent handing back its report
 * (`handback`), or another session writing to this one (`message`).
 */
export interface TaskNotification {
  kind?: "handback" | "message";
  /** The sender of a message: the subagent's agentId, or the other session's id. */
  from?: string;
  taskId?: string;
  /** The tool call that started the task (an Agent call for agents). */
  toolUseId?: string;
  /** "completed", "failed", "killed", … as Claude Code reports it. */
  status: string;
  summary: string;
  result?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/** A user prompt and everything the assistant produced until the next prompt. */
export interface Turn {
  id: string;
  prompt: string;
  timestamp?: string;
  blocks: Block[];
  /** Sent while Claude was still working on the previous prompt. */
  queued?: boolean;
  /** Claude finished answering (or a local command ran); only the last turn can still be running. */
  done?: boolean;
  /** The user stopped Claude: while it wrote (`user`) or during a tool call (`tool`). */
  interrupted?: "user" | "tool";
  /** What came with the prompt besides its text, in order. */
  attachments?: Attachment[];
  /** Not a prompt but Claude Code reporting that a background task stopped; `prompt` is its summary. */
  notification?: TaskNotification;
  /** The transcript the prompt is in, when a session spans several (`continuedIn`). */
  transcript?: string;
  /** Not a prompt but a compaction without one (automatic, mid-turn); its summary is the first block. */
  compacted?: boolean;
  /** Not a prompt but the place where the session went on under another id; `prompt` names it. */
  continuation?: Continuation;
  /** Tokens, models, tool calls and files of Claude's responses; none before the first one. */
  stats?: TurnStats;
}

/**
 * Where Claude Code went on with the session under a new id (a `continued-in`
 * entry), e.g. after /compact sent it to the background. Claude's answers that
 * follow belong to the entry, since no prompt comes before them.
 */
export interface Continuation {
  /** The session id it went on in. */
  sessionId?: string;
  /** The session id it came from; unknown when that transcript was not read. */
  fromSessionId?: string;
  /** The compaction that came with it. */
  compact?: CompactInfo;
  /** Claude Code sent the session to the background (to its daemon) just before. */
  backgrounded?: boolean;
}

/** What a `compact_boundary` entry says about the compaction. */
export interface CompactInfo {
  /** "manual" (/compact) or "auto". */
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
}

/**
 * Something sent along with a prompt: a pasted image (with the copy Claude
 * Code keeps under `~/.claude/uploads`, if it named one), a file or folder
 * mentioned with @, or lines selected in the IDE or a diff.
 */
export type Attachment =
  | { kind: "image"; path?: string }
  | { kind: "file"; path: string }
  | { kind: "directory"; path: string }
  | { kind: "selection"; lines?: number; file?: string };

/** "draft": being written in plan mode, not presented yet (see `PlanModeState`). */
export type PlanStatus = "draft" | "pending" | "approved" | "rejected";

/** A plan Claude presented in plan mode (the ExitPlanMode tool call). */
export interface Plan {
  /** The tool call id; the user's decision refers to it. */
  id: string;
  text: string;
  timestamp?: string;
  /** Prompt of the turn the plan was presented in. */
  prompt?: string;
  status: PlanStatus;
  /** What the user said when rejecting the plan, if anything. */
  feedback?: string;
}

/**
 * Plan mode as the transcript shows it. Claude Code writes the ExitPlanMode
 * call only once the user decided, but it names the plan file when plan mode
 * starts; Claude writes the plan there first, so the file shows it earlier.
 */
export interface PlanModeState {
  /** The plan file of this plan mode. */
  file: string;
  /** When plan mode started; an older file still holds a previous plan. */
  since?: string;
  /** Prompt of the turn plan mode started in. */
  prompt?: string;
}

interface ContentBlock {
  type: string;
  id?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

/** Where a `user` entry or a queued command came from; `peer` for a message from another agent. */
interface Origin {
  kind?: string;
  from?: string;
  senderTaskId?: string;
  /** The message; for a hand-back, a preamble and the subagent's report, indented. */
  body?: string;
  handback?: boolean;
}

interface Entry {
  type?: string;
  origin?: Origin;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  /** The summary /compact starts the conversation over with; not a prompt. */
  isCompactSummary?: boolean;
  cwd?: string;
  /** `continued-in` entry: the session goes on in this session's transcript. */
  continuedInSessionId?: string;
  sessionId?: string;
  /** `compact_boundary` entry. */
  compactMetadata?: { trigger?: unknown; preTokens?: unknown; postTokens?: unknown; durationMs?: unknown };
  /** Text of a `system` entry, e.g. a `local_command`. */
  content?: string;
  /** `custom-title` (set with /rename) and `ai-title` (named by Claude Code) entries. */
  customTitle?: string;
  aiTitle?: string;
  /** `agent-color` entry (set with /color): red, blue, green, yellow, purple, orange, pink or cyan. */
  agentColor?: string;
  message?: { id?: string; model?: string; usage?: Parameters<typeof usageCounts>[0]; content?: string | ContentBlock[]; stop_reason?: string | null };
  /** `turn_duration` entry. */
  durationMs?: unknown;
  /** Claude Code's structured copy of a tool result; for Agent calls with agentId, status and totals. */
  toolUseResult?: unknown;
  attachment?: {
    type?: string;
    prompt?: string | ContentBlock[];
    humanTurn?: boolean;
    origin?: Origin;
    commandMode?: string;
    planFilePath?: string;
    isSubAgent?: boolean;
    // file, directory, selected_lines_in_*, inlined_image_paths
    filename?: string;
    displayPath?: string;
    path?: string;
    paths?: unknown;
    lineCount?: number;
    lineStart?: number;
    lineEnd?: number;
  };
}

/** Attachment entries that carry something the user sent with a prompt; the others are Claude Code's own context. */
const ATTACHMENT_TYPES = new Set(["inlined_image_paths", "file", "directory", "selected_lines_in_ide", "selected_lines_in_diff"]);

/** `{ attachments }` when there are any, so turns without keep no empty list. */
function withAttachments(attachments: Attachment[]): { attachments?: Attachment[] } {
  return attachments.length > 0 ? { attachments } : {};
}

const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
const tagNumber = (text: string, name: string) => {
  const raw = tag(text, name);
  const n = Number(raw);
  return raw && Number.isFinite(n) ? n : undefined;
};

/**
 * The summary of a compaction without what is only meant for Claude: the
 * opening sentence before "Summary:" and the closing instructions (where the
 * full transcript is, continue without asking).
 */
export function compactSummaryText(text: string): string {
  let t = text.trim();
  if (t.startsWith("This session is being continued")) {
    const at = t.indexOf("Summary:");
    t = at >= 0 ? t.slice(at + "Summary:".length) : t.replace(/^[^\n]*\n/, "");
  }
  for (const tail of ["If you need specific details from before compaction", "Continue the conversation from where it left off"]) {
    const at = t.lastIndexOf(tail);
    if (at >= 0) t = t.slice(0, at);
  }
  return t.trim();
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The compaction a `compact_boundary` entry describes. */
function compactInfo(entry: Entry): CompactInfo {
  const m = entry.compactMetadata ?? {};
  return {
    trigger: typeof m.trigger === "string" ? m.trigger : undefined,
    preTokens: num(m.preTokens),
    postTokens: num(m.postTokens),
    durationMs: num(m.durationMs),
  };
}

/** Reads a `<task-notification>` message; undefined for anything else. */
export function taskNotification(text: string): TaskNotification | undefined {
  if (!text.trimStart().startsWith("<task-notification>")) return undefined;
  const status = tag(text, "status") ?? "completed";
  return {
    taskId: tag(text, "task-id"),
    toolUseId: tag(text, "tool-use-id"),
    status,
    summary: tag(text, "summary") ?? `Background task ${status}`,
    // An agent that handed back its report says so here instead of repeating it.
    result: HANDED_BACK.test(tag(text, "result") ?? "") ? undefined : tag(text, "result"),
    tokens: tagNumber(text, "subagent_tokens") ?? tagNumber(text, "total_tokens"),
    toolUses: tagNumber(text, "tool_uses"),
    durationMs: tagNumber(text, "duration_ms"),
  };
}

const HANDED_BACK = /^This agent's report was delivered to you as a message/;
const REPORT_START = /^[\s\S]*?The report follows:[^\n]*\n/;

/** A message from another agent (`origin.kind: "peer"`) as a user entry, or mid-turn as a queued command. */
function peerOf(entry: Entry): Origin | undefined {
  if (entry.isSidechain) return undefined;
  const origin = entry.type === "user" ? entry.origin : entry.type === "attachment" && entry.attachment?.type === "queued_command" ? entry.attachment.origin : undefined;
  return origin?.kind === "peer" ? origin : undefined;
}

/**
 * The text of a peer message: a hand-back without its preamble and with the
 * indentation Claude Code gives the report removed; a report in JSON as a code block.
 */
export function peerText(origin: Origin): string {
  let text = origin.body ?? "";
  if (origin.handback || REPORT_START.test(text)) {
    text = text.replace(REPORT_START, "");
    const lines = text.split("\n");
    if (lines.every((l) => l === "" || l.startsWith("  "))) text = lines.map((l) => l.slice(2)).join("\n");
  }
  text = text.trim();
  if (/^[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return "```json\n" + text + "\n```";
    } catch {
      // Not JSON after all: Markdown like any other report.
    }
  }
  return text;
}

/** The notification a user entry or queued command carries, if it is one. */
function notificationOf(entry: Entry): TaskNotification | undefined {
  if (entry.isSidechain) return undefined;
  if (entry.type === "attachment" && entry.attachment?.type === "queued_command") {
    const prompt = entry.attachment.prompt;
    return typeof prompt === "string" ? taskNotification(prompt) : undefined;
  }
  if (entry.type !== "user" || entry.isMeta) return undefined;
  const content = entry.message?.content;
  if (typeof content === "string") return taskNotification(content);
  if (!Array.isArray(content) || content.some((b) => b.type === "tool_result")) return undefined;
  return taskNotification(blocksText(content));
}

/** Pasted images of prompt content blocks, one attachment each. */
function imageAttachments(content: unknown): Attachment[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b?.type === "image").map(() => ({ kind: "image" as const }));
}

/**
 * Prompts typed while Claude is working are not stored as user entries: once
 * Claude takes them in mid-turn they appear as a `queued_command` attachment.
 */
function queuedPrompt(entry: Entry): string | undefined {
  const a = entry.attachment;
  if (entry.type !== "attachment" || entry.isSidechain || a?.type !== "queued_command") return undefined;
  if (!a.humanTurn && a.origin?.kind !== "human") return undefined;
  // A string, or content blocks when the prompt had images pasted into it; read like a prompt's.
  const prompt = a.prompt;
  const text = (typeof prompt === "string" ? prompt : Array.isArray(prompt) ? blocksText(prompt) : "").trim();
  return text || undefined;
}

/** "[Image]" or "[3 images]": stands in for a prompt of pasted images without text. */
export function imagesLabel(count: number): string {
  return count === 1 ? "[Image]" : `[${count} images]`;
}

/** The text of prompt content blocks; images alone become `imagesLabel`, so such a prompt still starts a turn. */
function blocksText(blocks: ContentBlock[]): string {
  const text = blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
  const images = blocks.filter((b) => b.type === "image").length;
  return text || (images > 0 ? imagesLabel(images) : "");
}

/** A prompt that ran a slash command (`/name args`) or a shell command (`! command`) instead of asking Claude. */
export const isCommand = (prompt: string) => prompt.startsWith("/") || prompt.startsWith("! ");

/**
 * Extracts the prompt text of a user entry, or undefined when the entry is not
 * a real prompt (tool results, meta reminders, interrupt markers, local command output).
 */
export function promptText(entry: Entry): string | undefined {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return undefined;
  const content = entry.message?.content;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((b) => b.type === "tool_result")) return undefined;
    text = blocksText(content);
  } else {
    return undefined;
  }
  text = text.trim();
  if (!text || text.startsWith("[Request interrupted")) return undefined;
  if (text.startsWith("<local-command") || text.startsWith("<system-reminder>")) return undefined;
  // A `!` command in Claude Code: its output follows as <bash-stdout>, which is not a prompt.
  const shell = /^<bash-input>(.*?)<\/bash-input>/s.exec(text);
  if (shell) return `! ${decodeEntities(shell[1].trim())}`;
  if (text.startsWith("<bash-stdout>") || text.startsWith("<bash-stderr>")) return undefined;
  return commandPrompt(text) ?? text;
}

/** `/name args` of a slash command as Claude Code records it (`<command-name>`, `<command-args>`). */
function commandPrompt(text: string): string | undefined {
  const command = /<command-name>(.*?)<\/command-name>/s.exec(text);
  if (!command) return undefined;
  const args = /<command-args>(.*?)<\/command-args>/s.exec(text)?.[1]?.trim();
  return args ? `${command[1]} ${args}` : command[1];
}

/**
 * A slash command that Claude Code records as a `system` `local_command` entry
 * instead of a `user` one (`/rename`, `/color`). It is written once the command
 * ran, with its output in a second such entry, so its turn is finished at once.
 */
function localCommandPrompt(entry: Entry): string | undefined {
  if (entry.type !== "system" || entry.subtype !== "local_command" || entry.isSidechain) return undefined;
  const text = entry.content?.trim();
  return text?.startsWith("<command-name>") ? commandPrompt(text) : undefined;
}

/** Claude Code escapes <, > and & in the input and output of `!` commands. */
function decodeEntities(text: string): string {
  return text.replace(/&(lt|gt|quot|#39|amp);/g, (_, name: string) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[name]!);
}

/**
 * The output of a `!` command as a Markdown code block: stdout, then stderr,
 * without the terminal's color codes. Claude Code writes it together with the
 * input line once the command ended, so there is no output while it runs.
 */
export function shellOutput(text: string): string | undefined {
  if (!text.startsWith("<bash-stdout>") && !text.startsWith("<bash-stderr>")) return undefined;
  const part = (tag: string) =>
    decodeEntities(new RegExp(`<${tag}>(.*?)</${tag}>`, "s").exec(text)?.[1] ?? "")
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
      .trimEnd();
  const output = [part("bash-stdout"), part("bash-stderr")].filter((s) => s.trim()).join("\n");
  if (!output) return "*(no output)*";
  // A fence longer than any run of backticks in the output.
  return fence(output);
}

/** The texts of a user entry that is not a tool result: its string content or its text blocks. */
function userTexts(entry: Entry): string[] {
  const content = entry.message?.content;
  if (typeof content === "string") return [content.trim()];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b.type === "text" && b.text).map((b) => b.text!.trim());
}

/**
 * Incrementally builds turns from transcript JSONL. Feed raw chunks as they are
 * appended to the file; incomplete trailing lines are buffered until completed.
 */
export class TranscriptParser {
  readonly turns: Turn[] = [];
  readonly plans: Plan[] = [];
  /** Set while plan mode is on, from its start until it is left. */
  planMode?: PlanModeState;
  /** Subagents started in this transcript, in order. */
  readonly agents: AgentRun[] = [];
  /** The session title Claude Code shows: the one set with /rename, else the one it generated. */
  get title(): string | undefined {
    return this.customTitle ?? this.aiTitle;
  }
  /** The session colour set with /color, as Claude Code names it; the last `agent-color` entry counts. */
  color?: string;
  /**
   * Set by a `continued-in` entry: the session goes on in the transcript of
   * this session id, in the same folder (Claude Code moves a session there,
   * e.g. when /compact sends it to the background).
   */
  continuedIn?: string;
  private customTitle?: string;
  private aiTitle?: string;
  private buffer = "";
  /** Tool calls waiting for their result, by tool call id. */
  private pendingTools = new Map<string, ToolBlock>();
  /** The turn of each pending tool call, whose stats count the files it writes. */
  private toolTurns = new Map<string, Turn>();
  /** The response counted last: its lines repeat its usage, which counts once. */
  private response?: { id: string; turn: Turn; output: number; model?: string };
  /** The last entry was a prompt (or one of its attachments): attachments that follow belong to it. */
  private takesAttachments = false;
  /** Uuids of the entries read, with `dedupe`: a continued session's transcript starts with copies of the last ones. */
  private seen?: Set<string>;
  /** The transcript began with a compact boundary: it continues one whose turns are not read. */
  private afterCompact = false;
  /** The last compaction and whether Claude Code sent the session to the background since the last prompt. */
  private lastCompact?: CompactInfo;
  private backgrounded = false;
  /**
   * `sidechains`: read sidechain entries like the main conversation. A
   * subagent's own transcript (`subagents/agent-<id>.jsonl`) consists of them.
   * `dedupe`: skip entries whose uuid was read before, for reading a
   * transcript and then the one it continues in (`continuedIn`).
   */
  constructor(private readonly opts: { sidechains?: boolean; dedupe?: boolean } = {}) {
    if (opts.dedupe) this.seen = new Set();
  }

  /** Before reading the next transcript: drops an incomplete last line of the previous one. */
  nextFile(): void {
    this.buffer = "";
  }

  /** Returns true when the turns, plans, title or colour changed. */
  push(chunk: string): boolean {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: Entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      changed = this.add(entry) || changed;
    }
    return changed;
  }

  /** Returns true when the title changed. Claude Code repeats these entries, the last one counts. */
  private trackTitle(entry: Entry): boolean {
    const before = this.title;
    if (entry.type === "custom-title") this.customTitle = entry.customTitle?.trim() || undefined;
    else this.aiTitle = entry.aiTitle?.trim() || undefined;
    return this.title !== before;
  }

  private add(entry: Entry): boolean {
    if (this.seen && entry.uuid) {
      if (this.seen.has(entry.uuid)) return false;
      this.seen.add(entry.uuid);
    }
    if (entry.type === "continued-in") {
      if (!entry.continuedInSessionId) return false;
      this.continuedIn = entry.continuedInSessionId;
      return this.addContinuation(entry);
    }
    if (!entry.isSidechain && (entry.type === "custom-title" || entry.type === "ai-title")) return this.trackTitle(entry);
    if (entry.type === "agent-color") {
      if (entry.isSidechain) return false;
      const before = this.color;
      this.color = entry.agentColor?.trim() || undefined;
      return this.color !== before;
    }
    if (this.opts.sidechains && entry.isSidechain) entry = { ...entry, isSidechain: false };
    const peer = peerOf(entry);
    if (peer) return this.addPeerMessage(entry, peer);
    const notification = notificationOf(entry);
    if (notification) return this.addNotification(entry, notification);
    const prompt = promptText(entry);
    if (prompt !== undefined && this.planMode && !this.planMode.prompt) this.planMode.prompt = prompt;
    if (prompt !== undefined) {
      // /compact is written twice: as typed, then as a command once it ran.
      const last = this.turns.at(-1);
      if (prompt.startsWith("/") && last?.prompt === prompt && !last.done && last.blocks.every((b) => b.kind === "compact")) {
        this.takesAttachments = false;
        return false;
      }
      this.lastCompact = undefined;
      this.backgrounded = false;
      this.turns.push({
        id: entry.uuid ?? String(this.turns.length),
        prompt,
        timestamp: entry.timestamp,
        blocks: [],
        ...withAttachments(imageAttachments(entry.message?.content)),
      });
      this.takesAttachments = true;
      return true;
    }
    if (entry.type === "attachment" && !entry.isSidechain) {
      const changed = this.trackPlanMode(entry) || this.trackAttachment(entry);
      if (changed) return true;
    }
    const queued = queuedPrompt(entry);
    if (queued !== undefined) {
      // Claude's following output responds to it, so it starts a turn of its own.
      this.turns.push({
        id: entry.uuid ?? String(this.turns.length),
        prompt: queued,
        timestamp: entry.timestamp,
        blocks: [],
        queued: true,
        ...withAttachments(imageAttachments(entry.attachment?.prompt)),
      });
      this.takesAttachments = true;
      return true;
    }
    const local = localCommandPrompt(entry);
    if (local !== undefined) {
      this.turns.push({ id: entry.uuid ?? String(this.turns.length), prompt: local, timestamp: entry.timestamp, blocks: [], done: true });
      this.takesAttachments = false;
      return true;
    }
    if (entry.isSidechain) return false;
    // Attachments belong to a prompt only when they follow it directly; after /compact, Claude Code re-attaches files it read.
    if (entry.type === "user" || entry.type === "assistant" || entry.type === "system") this.takesAttachments = false;
    // A transcript that begins with a compact boundary continues another; its first answer has no prompt here.
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      if (this.turns.length === 0) this.afterCompact = true;
      this.lastCompact = compactInfo(entry);
    }
    if (entry.type === "system" && entry.subtype === "informational" && entry.content?.startsWith("Backgrounding")) this.backgrounded = true;
    if (entry.type === "system" && entry.subtype === "away_summary") return this.addRecap(entry.content);
    if (entry.type === "system" && entry.subtype === "turn_duration") {
      const stats = this.turns.at(-1)?.stats;
      if (stats && num(entry.durationMs) !== undefined) stats.durationMs = num(entry.durationMs);
      return this.finish(true) || stats !== undefined;
    }
    if (entry.type === "system") return this.finish(entry.subtype === "local_command");
    if (entry.type === "user" && entry.isCompactSummary) return this.addCompactSummary(entry);
    if (entry.type === "user") {
      if (this.trackInterrupt(entry)) return true;
      const agents = this.trackAgentResults(entry);
      const tools = this.trackToolResults(entry);
      return this.decidePlans(entry) || agents || tools;
    }
    if (entry.type !== "assistant") return false;
    const content = entry.message?.content;
    if (!Array.isArray(content)) return false;

    let turn = this.turns.at(-1);
    if (!turn) {
      // Assistant output before any prompt (e.g. resumed session): collect it anyway.
      turn = this.afterCompact
        ? {
            id: "start",
            prompt: "Continued from an earlier session",
            timestamp: entry.timestamp,
            blocks: [],
            continuation: { sessionId: entry.sessionId, ...(this.lastCompact ? { compact: this.lastCompact } : {}) },
          }
        : { id: "start", prompt: "(session start)", timestamp: entry.timestamp, blocks: [] };
      this.turns.push(turn);
    }
    // Each line of a message carries its stop reason; the last one says whether Claude stopped or calls a tool.
    const stop = entry.message?.stop_reason;
    const done = stop === "end_turn" || stop === "stop_sequence";
    let changed = done !== (turn.done ?? false);
    turn.done = done;
    const stats = this.trackUsage(turn, entry);
    if (stats) changed = true;
    for (const b of content) {
      if (b.type === "text" && b.text?.trim()) {
        turn.blocks.push({ kind: "text", text: b.text });
      } else if (b.type === "thinking" && b.thinking?.trim()) {
        turn.blocks.push({ kind: "thinking", text: b.thinking });
      } else if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) {
        if (stats) stats.tools++;
        turn.blocks.push({ kind: "agent", agent: this.startAgent(b, entry.timestamp) });
      } else if (b.type === "tool_use") {
        const block: ToolBlock = { kind: "tool", id: b.id, name: b.name ?? "tool", input: b.input, cwd: entry.cwd };
        turn.blocks.push(block);
        if (stats) stats.tools++;
        if (b.id) {
          this.pendingTools.set(b.id, block);
          this.toolTurns.set(b.id, turn);
        }
        const plan = (b.input as { plan?: unknown } | undefined)?.plan;
        if (b.name === "ExitPlanMode" && typeof plan === "string" && plan.trim()) {
          this.plans.push({
            id: b.id ?? String(this.plans.length),
            text: plan,
            timestamp: entry.timestamp,
            prompt: turn.id === "start" || turn.continuation ? undefined : turn.prompt,
            status: "pending",
          });
        }
      } else {
        continue;
      }
      changed = true;
    }
    return changed;
  }

  /**
   * Counts a response's usage in its turn's stats, once per message id (each
   * of its lines repeats it; a later line replaces what an earlier one said).
   * Claude Code's own `<synthetic>` messages are no API calls and count not.
   */
  private trackUsage(turn: Turn, entry: Entry): TurnStats | undefined {
    const message = entry.message;
    if (message?.model === "<synthetic>") return turn.stats;
    const stats = (turn.stats ??= emptyStats());
    stats.end = entry.timestamp ?? stats.end;
    if (!message?.usage) return stats;
    const { output, context } = usageCounts(message.usage);
    const previous = this.response;
    if (previous && message.id && previous.id === message.id && previous.turn === turn) {
      stats.output -= previous.output;
      if (previous.model) stats.models[previous.model] -= previous.output;
    }
    stats.output += output;
    if (message.model) stats.models[message.model] = (stats.models[message.model] ?? 0) + output;
    stats.context = context;
    this.response = message.id ? { id: message.id, turn, output, model: message.model } : undefined;
    return stats;
  }

  /** A subagent started by an Agent (formerly Task) tool call. */
  private startAgent(b: ContentBlock, timestamp?: string): AgentRun {
    const input = (b.input ?? {}) as Record<string, unknown>;
    const text = (key: string) => (typeof input[key] === "string" && input[key] ? (input[key] as string) : undefined);
    const agent: AgentRun = {
      id: b.id ?? `agent-${this.agents.length}`,
      description: text("description") ?? "subagent",
      type: text("subagent_type"),
      model: text("model"),
      background: input.run_in_background === true || undefined,
      prompt: text("prompt"),
      status: "running",
      started: timestamp,
    };
    this.agents.push(agent);
    return agent;
  }

  /**
   * Applies the Agent tool's result: a background agent only reports its
   * launch (and its agentId); a foreground agent's result is its report.
   */
  /** Gives each tool call its outcome when its result arrives. */
  private trackToolResults(entry: Entry): boolean {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return false;
    let changed = false;
    for (const b of content) {
      if (b.type !== "tool_result" || !b.tool_use_id) continue;
      const block = this.pendingTools.get(b.tool_use_id);
      if (!block) continue;
      this.pendingTools.delete(b.tool_use_id);
      block.outcome = toolOutcome(block.name, block.input, entry.toolUseResult, b.content, b.is_error, block.cwd);
      const stats = this.toolTurns.get(b.tool_use_id)?.stats;
      this.toolTurns.delete(b.tool_use_id);
      if (stats) {
        if (!b.is_error) addFileChange(stats, block.name, block.input, entry.toolUseResult);
        stats.end = entry.timestamp ?? stats.end;
      }
      changed = true;
    }
    return changed;
  }

  private trackAgentResults(entry: Entry): boolean {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return false;
    let changed = false;
    for (const b of content) {
      if (b.type !== "tool_result") continue;
      const agent = this.agents.find((a) => a.id === b.tool_use_id);
      if (!agent) continue;
      const r = (entry.toolUseResult ?? {}) as Record<string, unknown>;
      if (typeof r.agentId === "string") agent.agentId = r.agentId;
      if (!agent.model && typeof r.resolvedModel === "string") agent.model = r.resolvedModel;
      if (r.status === "async_launched" || r.isAsync === true) {
        agent.background = true;
      } else {
        agent.status = b.is_error ? "failed" : "completed";
        agent.result = resultText(b.content).trim() || agent.result;
        if (typeof r.totalTokens === "number") agent.tokens = r.totalTokens;
        if (typeof r.totalToolUseCount === "number") agent.toolUses = r.totalToolUseCount;
        if (typeof r.totalDurationMs === "number") agent.durationMs = r.totalDurationMs;
      }
      changed = true;
    }
    return changed;
  }

  /**
   * A background task stopped. It gets a turn of its own, since Claude's
   * reaction to it follows, and updates the agent it reports on.
   */
  private addNotification(entry: Entry, notification: TaskNotification): boolean {
    this.turns.push({
      id: entry.uuid ?? String(this.turns.length),
      prompt: notification.summary,
      timestamp: entry.timestamp,
      blocks: [],
      notification,
    });
    this.takesAttachments = false;
    // After a resume, an agent the previous process left running is reported by its task id alone.
    const agent = this.agents.find((a) => (notification.toolUseId ? a.id === notification.toolUseId : a.agentId !== undefined && a.agentId === notification.taskId));
    if (agent) {
      notification.toolUseId = agent.id;
      const status = notification.status;
      agent.status = status === "completed" ? "completed" : status === "failed" ? "failed" : status === "killed" || status === "stopped" ? "killed" : agent.status;
      agent.result = notification.result || agent.result;
      agent.tokens = notification.tokens ?? agent.tokens;
      agent.toolUses = notification.toolUses ?? agent.toolUses;
      agent.durationMs = notification.durationMs ?? agent.durationMs;
    }
    return true;
  }

  /**
   * A message from another agent: a subagent's report (hand-back) or another
   * session writing. Like a notification it gets a turn of its own for
   * Claude's reaction, and a report becomes its agent's result.
   */
  private addPeerMessage(entry: Entry, origin: Origin): boolean {
    const from = origin.from ?? origin.senderTaskId;
    const agent = from ? this.agents.find((a) => a.agentId === from) : undefined;
    const handback = origin.handback === true || agent !== undefined;
    const result = peerText(origin);
    const name = agent ? `"${agent.description}"` : from ?? "an agent";
    this.turns.push({
      id: entry.uuid ?? String(this.turns.length),
      prompt: handback ? `Agent ${name} reported back` : `Message from ${name}`,
      timestamp: entry.timestamp,
      blocks: [],
      notification: { kind: handback ? "handback" : "message", from, toolUseId: agent?.id, status: "completed", summary: "", result: result || undefined },
    });
    this.takesAttachments = false;
    if (agent && result) agent.result = result;
    return true;
  }

  /** Adds @-mentions, IDE selections and the stored copies of pasted images to the prompt they came with. */
  private trackAttachment(entry: Entry): boolean {
    const a = entry.attachment;
    const turn = this.turns.at(-1);
    if (!a?.type || !turn || !this.takesAttachments || !ATTACHMENT_TYPES.has(a.type)) return false;
    const list = () => (turn.attachments ??= []);
    const name = a.displayPath || a.filename || a.path;
    switch (a.type) {
      case "inlined_image_paths": {
        const paths = Array.isArray(a.paths) ? a.paths.filter((p): p is string => typeof p === "string") : [];
        if (paths.length === 0) return false;
        // In paste order, like the image blocks of the prompt.
        const images = list().filter((x) => x.kind === "image");
        paths.forEach((path, i) => {
          if (images[i]) images[i].path = path;
          else list().push({ kind: "image", path });
        });
        return true;
      }
      case "file":
        if (!name) return false;
        list().push({ kind: "file", path: name });
        return true;
      case "directory":
        if (!name) return false;
        list().push({ kind: "directory", path: name });
        return true;
      case "selected_lines_in_ide":
      case "selected_lines_in_diff": {
        const span = a.lineStart !== undefined && a.lineEnd !== undefined ? a.lineEnd - a.lineStart + 1 : undefined;
        list().push({ kind: "selection", lines: a.lineCount ?? span, file: a.displayPath || a.filename });
        return true;
      }
      default:
        return false;
    }
  }

  /** The session goes on under another id: an entry of its own, which Claude's next answers belong to. */
  private addContinuation(entry: Entry): boolean {
    const next = entry.continuedInSessionId!;
    const continuation: Continuation = {
      sessionId: next,
      fromSessionId: entry.sessionId,
      ...(this.lastCompact ? { compact: this.lastCompact } : {}),
      ...(this.backgrounded ? { backgrounded: true } : {}),
    };
    this.lastCompact = undefined;
    this.backgrounded = false;
    this.takesAttachments = false;
    this.turns.push({ id: `continued-${next}`, prompt: `Session continues in ${next.slice(0, 8)}`, timestamp: entry.timestamp, blocks: [], done: true, continuation });
    return true;
  }

  /**
   * The summary of a compaction. After /compact it is that turn's answer; a
   * transcript that starts with it (continuing another) gets it in its first
   * entry; an automatic compaction mid-turn becomes an entry of its own, which
   * Claude's further work belongs to.
   */
  private addCompactSummary(entry: Entry): boolean {
    const content = entry.message?.content;
    const text = compactSummaryText(typeof content === "string" ? content : Array.isArray(content) ? blocksText(content) : "");
    if (!text) return false;
    const block: Block = { kind: "compact", text, ...(this.lastCompact ? { info: this.lastCompact } : {}) };
    const last = this.turns.at(-1);
    if (last && /^\/compact\b/.test(last.prompt) && last.blocks.length === 0) {
      last.blocks.push(block);
      return true;
    }
    if (!last && this.afterCompact) {
      this.turns.push({
        id: "start",
        prompt: "Continued from an earlier session",
        timestamp: entry.timestamp,
        blocks: [block],
        continuation: { sessionId: entry.sessionId, ...(this.lastCompact ? { compact: this.lastCompact } : {}) },
      });
      return true;
    }
    const auto = this.lastCompact?.trigger === "auto";
    this.turns.push({
      id: entry.uuid ?? String(this.turns.length),
      prompt: auto ? "Conversation compacted automatically" : "Conversation compacted",
      timestamp: entry.timestamp,
      blocks: [block],
      compacted: true,
    });
    return true;
  }

  /** A recap goes below the answer it follows; Claude Code's hint on turning recaps off is left out. */
  private addRecap(content: string | undefined): boolean {
    const text = content?.replace(/\s*\(disable recaps in \/config\)\s*$/, "").trim();
    const turn = this.turns.at(-1);
    if (!text || !turn) return false;
    turn.blocks.push({ kind: "recap", text });
    return true;
  }

  /** Marks the last turn finished when `finished`; returns whether that changed anything. */
  private finish(finished: boolean): boolean {
    const turn = this.turns.at(-1);
    if (!finished || !turn || turn.done) return false;
    turn.done = true;
    return true;
  }

  /** "[Request interrupted by user…]": the user stopped the last turn. Local and `!` command output ends it too. */
  private trackInterrupt(entry: Entry): boolean {
    for (const text of userTexts(entry)) {
      const output = shellOutput(text);
      const turn = this.turns.at(-1);
      if (output !== undefined && turn) {
        turn.blocks.push({ kind: "text", text: output });
        turn.done = true;
        return true;
      }
      if (text.startsWith("[Request interrupted")) {
        const turn = this.turns.at(-1);
        if (!turn) return false;
        turn.interrupted = text.startsWith("[Request interrupted by user for tool use") ? "tool" : "user";
        turn.done = true;
        return true;
      }
      if (text.startsWith("<local-command-stdout>")) return this.finish(true);
    }
    return false;
  }

  /** Follows plan mode through its attachments: start (and re-entry) name the plan file, exit ends it. */
  private trackPlanMode(entry: Entry): boolean {
    const a = entry.attachment;
    if (!a || a.isSubAgent) return false;
    if (a.type === "plan_mode" && a.planFilePath) {
      // Repeated reminders within the same plan mode keep its start.
      if (this.planMode?.file === a.planFilePath) return false;
      this.planMode = { file: a.planFilePath, since: entry.timestamp, prompt: this.turns.at(-1)?.prompt };
      return true;
    }
    if (a.type === "plan_mode_exit" && this.planMode) {
      this.planMode = undefined;
      return true;
    }
    return false;
  }

  /** Applies the user's answer to presented plans: approved, or rejected with optional feedback. */
  private decidePlans(entry: Entry): boolean {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return false;
    let changed = false;
    for (const b of content) {
      if (b.type !== "tool_result") continue;
      const plan = this.plans.find((p) => p.id === b.tool_use_id);
      if (!plan) continue;
      plan.status = b.is_error ? "rejected" : "approved";
      if (b.is_error) plan.feedback = rejectionFeedback(resultText(b.content));
      changed = true;
    }
    return changed;
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}

/** The user's words after "the user said:" in a rejected tool call, if they gave any. */
function rejectionFeedback(text: string): string | undefined {
  const said = /the user said:\s*([\s\S]*)$/i.exec(text)?.[1]?.trim();
  return said || undefined;
}

/** The line naming the browser page the actions below it (or the navigation above it) ran on. */
const pageLine = (page: string) => `*on ${escapeMd(page)}*`;

/** A screenshot of a turn: numbered from 1 in the turn, the browser call whose result holds it, and its place among that result's images. */
export interface Screenshot {
  n: number;
  block: ToolBlock;
  index: number;
}

/** The images of a turn's browser calls, numbered in order. */
export function turnScreenshots(turn: Pick<Turn, "blocks">): Screenshot[] {
  const shots: Screenshot[] = [];
  for (const b of turn.blocks) {
    if (b.kind !== "tool" || !isBrowserTool(b.name)) continue;
    (b.outcome?.images ?? []).forEach((_, index) => shots.push({ n: shots.length + 1, block: b, index }));
  }
  return shots;
}

/** Each browser call's screenshot numbers. */
function shotNumbers(shots: Screenshot[]): Map<ToolBlock, number[]> {
  const numbers = new Map<ToolBlock, number[]>();
  for (const s of shots) numbers.set(s.block, [...(numbers.get(s.block) ?? []), s.n]);
  return numbers;
}

/**
 * Builds the Markdown document shown for a turn. `shots` numbers the
 * screenshots when `turn` is a part of a turn (the chat renders the runs
 * between recaps apart); by default they are counted in `turn`. With tools
 * off, browser actions still show, in a frame per run of them that Claude's
 * text does not interrupt; `browser: false` leaves them out (copying).
 */
export function turnMarkdown(
  turn: Turn,
  opts: { tools: ToolLevel; thinking: boolean; agents?: boolean; browser?: boolean; shots?: Screenshot[] },
): string {
  const parts: string[] = [];
  const numbers = shotNumbers(opts.shots ?? turnScreenshots(turn));
  // The browser page the last browser action ran on: a line names it whenever it changes.
  let page: string | undefined;
  /** Puts the page line before an action, or after one that leads there. */
  const withPage = (b: ToolBlock, push: (s: string) => void, md: () => void) => {
    const on = b.outcome?.page !== undefined && b.outcome.page !== page ? pageLine(b.outcome.page) : undefined;
    if (on) page = b.outcome!.page;
    const after = on && navigates(b.name);
    if (on && !after) push(on);
    md();
    if (after) push(on);
  };
  // The open frame of browser actions (tools off): its paragraphs, the list items being collected, and its counts.
  let frame: { title: string; parts: string[]; items: string[]; actions: number; shots: number } | undefined;
  const closeItems = () => {
    if (frame?.items.length) frame.parts.push(frame.items.join("\n"));
    if (frame) frame.items = [];
  };
  const closeFrame = () => {
    if (!frame) return;
    closeItems();
    const counts = [plural(frame.actions, "action"), ...(frame.shots ? [plural(frame.shots, "screenshot")] : [])];
    parts.push(`${BOX_START_CYAN}${frame.title} · ${counts.join(" · ")}\n${frame.parts.join("\n\n")}\n${BOX_END}`);
    frame = undefined;
  };
  /** A part outside a frame; it ends the frame before it. */
  const push = (s: string) => {
    closeFrame();
    parts.push(s);
  };
  for (const b of turn.blocks) {
    if (b.kind === "text") {
      push(b.text);
    } else if (b.kind === "thinking" && opts.thinking) {
      push(b.text.split("\n").map((l) => `> ${l}`).join("\n"));
    } else if (b.kind === "tool" && opts.tools === "off" && isBrowserTool(b.name)) {
      if (opts.browser === false) continue;
      if (!frame) {
        frame = { title: browserTitle(b.name), parts: [], items: [], actions: 0, shots: 0 };
        // Each frame names the page it starts on.
        page = undefined;
      }
      const open = frame;
      const items = browserItems(b.name, b.input, b.outcome, numbers.get(b));
      open.actions += items.length;
      open.shots += numbers.get(b)?.length ?? 0;
      withPage(
        b,
        (line) => {
          // A page line right after another (a navigation lands before the page has its title) replaces it.
          if (open.items.length === 0 && open.parts.length > 0 && open.parts.at(-1)!.startsWith("*on ")) open.parts.pop();
          closeItems();
          open.parts.push(line);
        },
        () => open.items.push(...items),
      );
    } else if (b.kind === "tool") {
      // Questions and answers are part of the conversation: with tools off they still show, framed.
      const md = toolMarkdown(b.name, b.input, b.outcome, opts.tools, b.cwd, numbers.get(b));
      if (!md) continue;
      if (isBrowserTool(b.name)) withPage(b, push, () => push(md));
      else push(md);
    } else if (b.kind === "agent" && opts.agents) {
      push(agentMarkdown(b.agent));
    } else if (b.kind === "compact") {
      push(b.text);
    }
  }
  closeFrame();
  return parts.join("\n\n");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Marks the start of a running agent's status in the rendered answer; the chat spins it. */
export const AGENT_RUNNING_MARK = "⠿";

const AGENT_STATUS_ICON: Record<AgentStatus, string> = {
  running: AGENT_RUNNING_MARK,
  completed: "✓",
  failed: "✗",
  killed: "■",
};

/** "3 min 10 s", "45 s" */
export function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${String(s % 60).padStart(2, "0")} s` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** "139k tokens" */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k tokens` : `${n} tokens`;
}

/** The status line of an agent: "✓ completed · 3 min 10 s · 30 tool uses · 139k tokens". */
export function agentStatusLine(agent: AgentRun): string {
  return [
    `${AGENT_STATUS_ICON[agent.status]} ${agent.status}`,
    ...(agent.durationMs !== undefined ? [formatMs(agent.durationMs)] : []),
    ...(agent.toolUses !== undefined ? [`${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"}`] : []),
    ...(agent.tokens !== undefined ? [formatTokens(agent.tokens)] : []),
  ].join(" · ");
}

/** The heading of an agent: "Explore · Anwendungsstruktur erheben · sonnet · background". */
export function agentTitle(agent: AgentRun): string {
  return [agent.type ?? "agent", agent.description, ...(agent.model ? [agent.model] : []), ...(agent.background ? ["background"] : [])].join(" · ");
}

/** An agent in the answer: its title, then its status on a line of its own. */
function agentMarkdown(agent: AgentRun): string {
  const escape = (s: string) => s.replace(/([\\`*_[\]<>])/g, "\\$1");
  return `**◆ ${escape(agentTitle(agent))}**  \n${escape(agentStatusLine(agent))}`;
}
