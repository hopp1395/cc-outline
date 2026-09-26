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
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}

interface Entry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { id?: string; content?: string | ContentBlock[] };
  attachment?: { type?: string; prompt?: string; humanTurn?: boolean; origin?: { kind?: string } };
}

/**
 * Prompts typed while Claude is working are not stored as user entries: once
 * Claude takes them in mid-turn they appear as a `queued_command` attachment.
 */
function queuedPrompt(entry: Entry): string | undefined {
  const a = entry.attachment;
  if (entry.type !== "attachment" || entry.isSidechain || a?.type !== "queued_command") return undefined;
  if (!a.humanTurn && a.origin?.kind !== "human") return undefined;
  const text = a.prompt?.trim();
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

/**
 * Incrementally builds turns from transcript JSONL. Feed raw chunks as they are
 * appended to the file; incomplete trailing lines are buffered until completed.
 */
export class TranscriptParser {
  readonly turns: Turn[] = [];
  private buffer = "";

  /** Returns true when the turn list changed. */
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
    if (prompt !== undefined) {
      this.turns.push({
        id: entry.uuid ?? String(this.turns.length),
        prompt,
        timestamp: entry.timestamp,
        blocks: [],
      });
      return true;
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
    if (entry.type !== "assistant" || entry.isSidechain) return false;
    const content = entry.message?.content;
    if (!Array.isArray(content)) return false;

    let turn = this.turns.at(-1);
    if (!turn) {
      // Assistant output before any prompt (e.g. resumed session): collect it anyway.
      turn = { id: "start", prompt: "(session start)", timestamp: entry.timestamp, blocks: [] };
      this.turns.push(turn);
    }
    let changed = false;
    for (const b of content) {
      if (b.type === "text" && b.text?.trim()) {
        turn.blocks.push({ kind: "text", text: b.text });
      } else if (b.type === "thinking" && b.thinking?.trim()) {
        turn.blocks.push({ kind: "thinking", text: b.thinking });
      } else if (b.type === "tool_use") {
        turn.blocks.push({ kind: "tool", name: b.name ?? "tool", input: b.input });
      } else {
        continue;
      }
      changed = true;
    }
    return changed;
  }
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
