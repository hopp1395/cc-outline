import { fence, toolMarkdown, toolOutcome, type ToolLevel, type ToolOutcome } from "./tools.js";

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
  | { kind: "agent"; agent: AgentRun };

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
}

/** A `<task-notification>`: a background agent or command stopped. */
export interface TaskNotification {
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

interface Entry {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  cwd?: string;
  message?: { id?: string; content?: string | ContentBlock[]; stop_reason?: string | null };
  /** Claude Code's structured copy of a tool result; for Agent calls with agentId, status and totals. */
  toolUseResult?: unknown;
  attachment?: {
    type?: string;
    prompt?: string | ContentBlock[];
    humanTurn?: boolean;
    origin?: { kind?: string };
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

/** Reads a `<task-notification>` message; undefined for anything else. */
export function taskNotification(text: string): TaskNotification | undefined {
  if (!text.trimStart().startsWith("<task-notification>")) return undefined;
  const status = tag(text, "status") ?? "completed";
  return {
    taskId: tag(text, "task-id"),
    toolUseId: tag(text, "tool-use-id"),
    status,
    summary: tag(text, "summary") ?? `Background task ${status}`,
    result: tag(text, "result"),
    tokens: tagNumber(text, "subagent_tokens") ?? tagNumber(text, "total_tokens"),
    toolUses: tagNumber(text, "tool_uses"),
    durationMs: tagNumber(text, "duration_ms"),
  };
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
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return undefined;
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
  const command = /<command-name>(.*?)<\/command-name>/s.exec(text);
  if (command) {
    const args = /<command-args>(.*?)<\/command-args>/s.exec(text)?.[1]?.trim();
    return args ? `${command[1]} ${args}` : command[1];
  }
  return text;
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
  private buffer = "";
  /** Tool calls waiting for their result, by tool call id. */
  private pendingTools = new Map<string, ToolBlock>();
  /** The last entry was a prompt (or one of its attachments): attachments that follow belong to it. */
  private takesAttachments = false;
  /**
   * `sidechains`: read sidechain entries like the main conversation. A
   * subagent's own transcript (`subagents/agent-<id>.jsonl`) consists of them.
   */
  constructor(private readonly opts: { sidechains?: boolean } = {}) {}

  /** Returns true when the turns or plans changed. */
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

  private add(entry: Entry): boolean {
    if (this.opts.sidechains && entry.isSidechain) entry = { ...entry, isSidechain: false };
    const notification = notificationOf(entry);
    if (notification) return this.addNotification(entry, notification);
    const prompt = promptText(entry);
    if (prompt !== undefined && this.planMode && !this.planMode.prompt) this.planMode.prompt = prompt;
    if (prompt !== undefined) {
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
    if (entry.isSidechain) return false;
    // Attachments belong to a prompt only when they follow it directly; after /compact, Claude Code re-attaches files it read.
    if (entry.type === "user" || entry.type === "assistant" || entry.type === "system") this.takesAttachments = false;
    if (entry.type === "system") return this.finish(entry.subtype === "turn_duration" || entry.subtype === "local_command");
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
      turn = { id: "start", prompt: "(session start)", timestamp: entry.timestamp, blocks: [] };
      this.turns.push(turn);
    }
    // Each line of a message carries its stop reason; the last one says whether Claude stopped or calls a tool.
    const stop = entry.message?.stop_reason;
    const done = stop === "end_turn" || stop === "stop_sequence";
    let changed = done !== (turn.done ?? false);
    turn.done = done;
    for (const b of content) {
      if (b.type === "text" && b.text?.trim()) {
        turn.blocks.push({ kind: "text", text: b.text });
      } else if (b.type === "thinking" && b.thinking?.trim()) {
        turn.blocks.push({ kind: "thinking", text: b.thinking });
      } else if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) {
        turn.blocks.push({ kind: "agent", agent: this.startAgent(b, entry.timestamp) });
      } else if (b.type === "tool_use") {
        const block: ToolBlock = { kind: "tool", id: b.id, name: b.name ?? "tool", input: b.input, cwd: entry.cwd };
        turn.blocks.push(block);
        if (b.id) this.pendingTools.set(b.id, block);
        const plan = (b.input as { plan?: unknown } | undefined)?.plan;
        if (b.name === "ExitPlanMode" && typeof plan === "string" && plan.trim()) {
          this.plans.push({
            id: b.id ?? String(this.plans.length),
            text: plan,
            timestamp: entry.timestamp,
            prompt: turn.id === "start" ? undefined : turn.prompt,
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
    const agent = this.agents.find((a) => a.id === notification.toolUseId);
    if (agent) {
      const status = notification.status;
      agent.status = status === "completed" ? "completed" : status === "failed" ? "failed" : status === "killed" || status === "stopped" ? "killed" : agent.status;
      agent.result = notification.result || agent.result;
      agent.tokens = notification.tokens ?? agent.tokens;
      agent.toolUses = notification.toolUses ?? agent.toolUses;
      agent.durationMs = notification.durationMs ?? agent.durationMs;
    }
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

/** Builds the Markdown document shown for a turn. */
export function turnMarkdown(turn: Turn, opts: { tools: ToolLevel; thinking: boolean; agents?: boolean }): string {
  const parts: string[] = [];
  for (const b of turn.blocks) {
    if (b.kind === "text") {
      parts.push(b.text);
    } else if (b.kind === "thinking" && opts.thinking) {
      parts.push(b.text.split("\n").map((l) => `> ${l}`).join("\n"));
    } else if (b.kind === "tool") {
      // Questions and answers are part of the conversation: shown at every level.
      const md = toolMarkdown(b.name, b.input, b.outcome, opts.tools, b.cwd);
      if (md) parts.push(md);
    } else if (b.kind === "agent" && opts.agents) {
      parts.push(agentMarkdown(b.agent));
    }
  }
  return parts.join("\n\n");
}

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
