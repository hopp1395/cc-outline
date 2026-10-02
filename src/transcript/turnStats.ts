/**
 * What a turn cost: its API responses (output tokens, the context of the last
 * one, the models), its tool calls and the files it created or changed.
 * Kept as numbers while the parser reads, so it survives `SessionReader`
 * dropping the blocks.
 */
export interface TurnStats {
  /** Output tokens of all responses, thinking included. */
  output: number;
  /** Input plus cache read and written of the last response: how full the context was at the end. */
  context: number;
  /** Output tokens per model. */
  models: Record<string, number>;
  /** Tool calls of the main thread, Agent calls included. */
  tools: number;
  /** The same per tool name, e.g. `{ Read: 9, Edit: 6 }`. */
  toolNames: Record<string, number>;
  /** Per file the turn wrote to: created (`new`) or changed; a file created and then edited stays `new`. */
  files: Record<string, "new" | "changed">;
  /** Per file the lines added and removed; `added` and `removed` are their sums. */
  lines: Record<string, { added: number; removed: number }>;
  added: number;
  removed: number;
  /** From the `turn_duration` entry; missing for interrupted turns and older transcripts. */
  durationMs?: number;
  /** Timestamp of the turn's last entry, for the duration when `durationMs` is missing. */
  end?: string;
}

export const emptyStats = (): TurnStats => ({ output: 0, context: 0, models: {}, tools: 0, toolNames: {}, files: {}, lines: {}, added: 0, removed: 0 });

/** Counts a tool call of the main thread under its name. */
export function addToolCall(stats: TurnStats, name: string): void {
  stats.tools++;
  stats.toolNames[name] = (stats.toolNames[name] ?? 0) + 1;
}

interface Usage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The output tokens and the context size of a response's `usage`. */
export function usageCounts(usage: Usage | undefined): { output: number; context: number } {
  return {
    output: num(usage?.output_tokens),
    context: num(usage?.input_tokens) + num(usage?.cache_creation_input_tokens) + num(usage?.cache_read_input_tokens),
  };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Added and removed lines of a structuredPatch. */
function patchLines(patch: unknown): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (!Array.isArray(patch)) return { added, removed };
  for (const hunk of patch) {
    const lines = obj(hunk).lines;
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

const WRITING_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Counts a successful Edit, MultiEdit, Write or NotebookEdit: its file and its lines. */
export function addFileChange(stats: TurnStats, name: string, input: unknown, result: unknown): void {
  if (!WRITING_TOOLS.has(name)) return;
  const i = obj(input);
  const r = obj(result);
  const path = [r.filePath, i.file_path, i.notebook_path].find((p): p is string => typeof p === "string" && p !== "");
  if (!path) return;
  const created = name === "Write" && r.type === "create";
  let added = 0;
  let removed = 0;
  if (created) {
    const content = typeof i.content === "string" ? i.content : typeof r.content === "string" ? r.content : "";
    added = content ? content.replace(/\n$/, "").split("\n").length : 0;
  } else {
    ({ added, removed } = patchLines(r.structuredPatch));
  }
  stats.added += added;
  stats.removed += removed;
  const lines = (stats.lines[path] ??= { added: 0, removed: 0 });
  lines.added += added;
  lines.removed += removed;
  if (created || stats.files[path] === undefined) stats.files[path] = created ? "new" : "changed";
}

/** "claude-opus-5-5" → "opus-5.5", "claude-haiku-4-5-20251001" → "haiku-4.5". */
export function shortModel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (m) return m[3] ? `${m[1]}-${m[2]}.${m[3]}` : `${m[1]}-${m[2]}`;
  return model.replace(/^claude-/, "");
}

/** "840", "3.2k", "84k", "1.2M". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
