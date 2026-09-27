/** One block of assistant output, in transcript order. */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; input: unknown };

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
}

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
  message?: { id?: string; content?: string | ContentBlock[]; stop_reason?: string | null };
  attachment?: {
    type?: string;
    prompt?: string | ContentBlock[];
    humanTurn?: boolean;
    origin?: { kind?: string };
    planFilePath?: string;
    isSubAgent?: boolean;
  };
}

/**
 * Prompts typed while Claude is working are not stored as user entries: once
 * Claude takes them in mid-turn they appear as a `queued_command` attachment.
 */
function queuedPrompt(entry: Entry): string | undefined {
  const a = entry.attachment;
  if (entry.type !== "attachment" || entry.isSidechain || a?.type !== "queued_command") return undefined;
  if (!a.humanTurn && a.origin?.kind !== "human") return undefined;
  // A string, or content blocks when the prompt had images pasted into it; only its text counts, as for prompts.
  const prompt = a.prompt;
  const text = (
    typeof prompt === "string"
      ? prompt
      : Array.isArray(prompt)
        ? prompt
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text)
            .join("\n")
        : ""
  ).trim();
  return text || undefined;
}

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
    text = content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
  } else {
    return undefined;
  }
  text = text.trim();
  if (!text || text.startsWith("[Request interrupted")) return undefined;
  if (text.startsWith("<local-command") || text.startsWith("<system-reminder>")) return undefined;
  const command = /<command-name>(.*?)<\/command-name>/s.exec(text);
  if (command) {
    const args = /<command-args>(.*?)<\/command-args>/s.exec(text)?.[1]?.trim();
    return args ? `${command[1]} ${args}` : command[1];
  }
  return text;
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
  private buffer = "";

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
    const prompt = promptText(entry);
    if (prompt !== undefined && this.planMode && !this.planMode.prompt) this.planMode.prompt = prompt;
    if (prompt !== undefined) {
      this.turns.push({
        id: entry.uuid ?? String(this.turns.length),
        prompt,
        timestamp: entry.timestamp,
        blocks: [],
      });
      return true;
    }
    if (entry.type === "attachment" && !entry.isSidechain) {
      const changed = this.trackPlanMode(entry);
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
      });
      return true;
    }
    if (entry.isSidechain) return false;
    if (entry.type === "system") return this.finish(entry.subtype === "turn_duration" || entry.subtype === "local_command");
    if (entry.type === "user") return this.trackInterrupt(entry) || this.decidePlans(entry);
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
      } else if (b.type === "tool_use") {
        turn.blocks.push({ kind: "tool", name: b.name ?? "tool", input: b.input });
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

  /** Marks the last turn finished when `finished`; returns whether that changed anything. */
  private finish(finished: boolean): boolean {
    const turn = this.turns.at(-1);
    if (!finished || !turn || turn.done) return false;
    turn.done = true;
    return true;
  }

  /** "[Request interrupted by user…]": the user stopped the last turn. Local command output ends it too. */
  private trackInterrupt(entry: Entry): boolean {
    for (const text of userTexts(entry)) {
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
export function turnMarkdown(turn: Turn, opts: { tools: boolean; thinking: boolean }): string {
  const parts: string[] = [];
  for (const b of turn.blocks) {
    if (b.kind === "text") {
      parts.push(b.text);
    } else if (b.kind === "thinking" && opts.thinking) {
      parts.push(b.text.split("\n").map((l) => `> ${l}`).join("\n"));
    } else if (b.kind === "tool" && opts.tools) {
      parts.push(`**⚙ ${b.name}** \`${toolSummary(b.input)}\``);
    }
  }
  return parts.join("\n\n");
}

function toolSummary(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const key = ["command", "file_path", "pattern", "path", "url", "description"].find(
      (k) => typeof o[k] === "string",
    );
    const value = key ? (o[key] as string) : JSON.stringify(input);
    const oneLine = value.replace(/\s+/g, " ").replace(/`/g, "'");
    return oneLine.length > 100 ? oneLine.slice(0, 99) + "…" : oneLine;
  }
  return String(input ?? "");
}
