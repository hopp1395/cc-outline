import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { boxesAsQuotes } from "../render/markdown.js";
import { readSessionPlacement, readSessionView } from "../sessionViews.js";
import { readFavorites } from "../favorites.js";
import { readPositions, type PositionList } from "../positions.js";
import {
  agentStatusLine,
  agentTitle,
  formatMs,
  formatTokens,
  TranscriptParser,
  turnMarkdown,
  turnScreenshots,
  type AgentRun,
  type Attachment,
  type Block,
  type CompactInfo,
  type Plan,
  type Screenshot,
  type Turn,
} from "../transcript/parse.js";
import { formatCount, shortModel } from "../transcript/turnStats.js";
import { lastActive, type SessionSummary } from "../transcript/sessions.js";
import { subagentFile } from "../transcript/subagents.js";
import type { ToolLevel } from "../transcript/tools.js";
import { VERSION } from "../version.js";

/** How the subagents are exported: left out, their reports, or their reports and whole conversations. */
export type AgentExport = "none" | "reports" | "full";

/** What the export dialog lets the user choose; the backup ignores it. */
export interface ExportOptions {
  tools: ToolLevel;
  thinking: boolean;
  agents: AgentExport;
  stats: boolean;
}

/** A file of the export besides its document: an image, a subagent's conversation. */
export interface ExportFile {
  /** Relative to the format's folder, forward slashes. */
  name: string;
  data: () => Buffer | string | undefined;
}

/** A session read for the export: every transcript of its chain, oldest first, read with one parser. */
export interface LoadedSession {
  summary: SessionSummary;
  transcripts: string[];
  turns: Turn[];
  plans: Plan[];
  agents: AgentRun[];
  title?: string;
}

/** The transcripts of `s`: those it continued from, then its own. */
export function sessionTranscripts(s: SessionSummary): string[] {
  const dir = dirname(s.path);
  return [...(s.continues ?? []).map((id) => join(dir, `${id}.jsonl`)), s.path].filter((f) => existsSync(f));
}

/** Reads the whole session, as the chat does: one parser over its chain, turns and agents stamped with their transcript. */
export function loadSession(s: SessionSummary): LoadedSession {
  const parser = new TranscriptParser({ dedupe: true });
  const transcripts = sessionTranscripts(s);
  for (const file of transcripts) {
    const turns = parser.turns.length;
    const agents = parser.agents.length;
    parser.nextFile();
    parser.push(readFileSync(file, "utf8") + "\n");
    for (const t of parser.turns.slice(turns)) t.transcript ??= file;
    for (const a of parser.agents.slice(agents)) a.transcript ??= file;
  }
  return { summary: s, transcripts, turns: [...parser.turns], plans: parser.plans.map((p) => ({ ...p })), agents: [...parser.agents], title: parser.title };
}

/** The conversation of a subagent, from its own transcript; undefined when that is gone. */
export function loadSubagent(session: LoadedSession, agent: AgentRun): Turn[] | undefined {
  const file = subagentFile(agent.transcript ?? session.summary.path, agent);
  if (!file) return undefined;
  const parser = new TranscriptParser({ sidechains: true });
  try {
    parser.push(readFileSync(file, "utf8") + "\n");
  } catch {
    return undefined;
  }
  return parser.turns;
}

// --- Images -----------------------------------------------------------------------------------

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

interface ImageBlock {
  type?: string;
  source?: { type?: string; media_type?: string; data?: string };
}

interface TranscriptImages {
  /** Image blocks of a prompt (or queued prompt), by the entry's uuid. */
  prompts: Map<string, ImageBlock[]>;
  /** Image blocks of a tool result, by its tool_use_id. */
  results: Map<string, ImageBlock[]>;
}

/** An image to put into the export: its data and its file extension. */
interface ImageData {
  data: Buffer;
  ext: string;
}

/**
 * Finds the images of a session's prompts and tool results: the copies Claude
 * Code keeps where they still exist, else the base64 data in the transcript,
 * which each transcript is read for once.
 */
export class ImageSource {
  private cache = new Map<string, TranscriptImages>();

  private of(transcript: string): TranscriptImages {
    let found = this.cache.get(transcript);
    if (found) return found;
    found = { prompts: new Map(), results: new Map() };
    this.cache.set(transcript, found);
    let text: string;
    try {
      text = readFileSync(transcript, "utf8");
    } catch {
      return found;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"image"')) continue;
      try {
        const entry = JSON.parse(line) as { uuid?: string; message?: { content?: unknown }; attachment?: { prompt?: unknown } };
        const content = entry.message?.content ?? entry.attachment?.prompt;
        if (!Array.isArray(content)) continue;
        const images = (content as ImageBlock[]).filter((b) => b?.type === "image");
        if (images.length && entry.uuid) found.prompts.set(entry.uuid, images);
        for (const b of content as { type?: string; tool_use_id?: string; content?: unknown }[]) {
          if (b?.type !== "tool_result" || !b.tool_use_id || !Array.isArray(b.content)) continue;
          found.results.set(b.tool_use_id, (b.content as ImageBlock[]).filter((c) => c?.type === "image"));
        }
      } catch {
        continue;
      }
    }
    return found;
  }

  private static decode(block: ImageBlock | undefined): ImageData | undefined {
    const source = block?.source;
    if (source?.type !== "base64" || !source.data) return undefined;
    return { data: Buffer.from(source.data, "base64"), ext: EXTENSIONS[source.media_type ?? ""] ?? "png" };
  }

  private static file(path: string | undefined): ImageData | undefined {
    if (!path || !existsSync(path)) return undefined;
    try {
      return { data: readFileSync(path), ext: (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "png").toLowerCase() };
    } catch {
      return undefined;
    }
  }

  /** The `i`th image pasted into `turn`'s prompt. */
  promptImage(turn: Turn, image: Extract<Attachment, { kind: "image" }>, i: number): ImageData | undefined {
    return ImageSource.file(image.path) ?? (turn.transcript ? ImageSource.decode(this.of(turn.transcript).prompts.get(turn.id)?.[i]) : undefined);
  }

  /** A browser screenshot of `turn`. */
  screenshot(turn: Turn, shot: Screenshot): ImageData | undefined {
    const saved = ImageSource.file(shot.block.outcome?.images?.[shot.index]?.path);
    if (saved) return saved;
    const id = shot.block.id;
    return turn.transcript && id ? ImageSource.decode(this.of(turn.transcript).results.get(id)?.[shot.index]) : undefined;
  }
}

/** Collects the images of a document under `attachments/`, each once. */
class Attachments {
  readonly files: ExportFile[] = [];
  private names = new Map<string, string>();

  constructor(private readonly images: ImageSource) {}

  /** The file name of the image `key`, added on first use; undefined when there is no image data. */
  add(key: string, base: string, load: () => ImageData | undefined): string | undefined {
    const known = this.names.get(key);
    if (known) return known;
    const image = load();
    if (!image) return undefined;
    const name = `attachments/${base}.${image.ext}`;
    this.names.set(key, name);
    this.files.push({ name, data: () => image.data });
    return name;
  }

  promptImages(turn: Turn, n: number): { label: string; file?: string }[] {
    const images = (turn.attachments ?? []).filter((a): a is Extract<Attachment, { kind: "image" }> => a.kind === "image");
    return images.map((image, i) => ({
      label: `Image ${i + 1}`,
      file: this.add(`${turn.id}#${i}`, `turn-${pad3(n)}-image-${i + 1}`, () => this.images.promptImage(turn, image, i)),
    }));
  }

  screenshot(turn: Turn, n: number, shot: Screenshot): string | undefined {
    return this.add(`${turn.id}#shot${shot.n}`, `turn-${pad3(n)}-shot-${shot.n}`, () => this.images.screenshot(turn, shot));
  }
}

// --- Formatting helpers -----------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const pad3 = (n: number) => String(n).padStart(3, "0");

/** "2026-10-02 14:30" in local time. */
export function localTime(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2026-10-02-1430": a session's folder in the archive starts with it. */
export function folderStamp(ts: string | undefined): string {
  const t = localTime(ts);
  return t ? t.replace(" ", "-").replace(":", "") : "0000-00-00-0000";
}

/** The folder of a session's format in the archive: `<YYYY-MM-DD-HHMM>-<id8>-<format>`, with the time of its last activity. */
export function sessionFolder(s: SessionSummary, format: ExportFormat): string {
  return `${folderStamp(lastActive(s))}-${s.id.slice(0, 8)}-${format}`;
}

export const EXPORT_FORMATS = ["markdown", "llm", "json", "backup"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const escapeMd = (s: string) => s.replace(/([\\`*_[\]<>])/g, "\\$1");
const quote = (text: string) =>
  text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
const code = (s: string) => (s.includes("`") ? `\`\` ${s} \`\`` : `\`${s}\``);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const LEVELS: ToolLevel[] = ["off", "compact", "full"];
const atMost = (level: ToolLevel, max: ToolLevel) => (LEVELS.indexOf(level) > LEVELS.indexOf(max) ? max : level);

/** A file name part made of `text`: letters, digits and dashes. */
const slug = (text: string) => text.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";

/** The session's name: its title, else its first prompt that is no command. */
export function exportTitle(session: LoadedSession): string {
  const s = session.summary;
  return s.title ?? session.title ?? s.prompts.find((p) => !p.text.startsWith("/") && !p.text.startsWith("! "))?.text.split("\n")[0] ?? s.id;
}

/** "2026-10-02 14:30 – 16:05 (1 h 35 min)". */
function spanText(start?: string, end?: string): string | undefined {
  const s = localTime(start);
  if (!s) return undefined;
  const e = localTime(end);
  const ms = start && end ? Date.parse(end) - Date.parse(start) : NaN;
  const to = e && e !== s ? ` – ${e.slice(0, 10) === s.slice(0, 10) ? e.slice(11) : e}` : "";
  return `${s}${to}${Number.isFinite(ms) && ms >= 60_000 ? ` (${formatMs(ms)})` : ""}`;
}

/** "/compact · 217k → 10k tokens · 43 s". */
function compactText(info: CompactInfo | undefined): string {
  if (!info) return "";
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const sizes = info.preTokens !== undefined && info.postTokens !== undefined ? `${k(info.preTokens)} → ${formatTokens(info.postTokens)}` : undefined;
  return [info.trigger === "auto" ? "compacted automatically" : "/compact", sizes, info.durationMs !== undefined ? formatMs(info.durationMs) : undefined]
    .filter(Boolean)
    .join(" · ");
}

/** The turn's stats as one line: duration, tokens, context, models, tools, agents, files and lines. */
export function statsText(turn: Turn, agents: AgentRun[]): string | undefined {
  const s = turn.stats;
  if (!s) return undefined;
  const start = turn.timestamp ? Date.parse(turn.timestamp) : NaN;
  const ms = s.durationMs ?? (s.end ? Date.parse(s.end) - start : NaN);
  const models = Object.entries(s.models)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => shortModel(m));
  const files = Object.values(s.files);
  const created = files.filter((f) => f === "new").length;
  const changed = files.length - created;
  const parts = [
    ...(Number.isFinite(ms) && ms >= 0 ? [formatMs(ms)] : []),
    ...(s.output > 0 ? [`↓ ${formatCount(s.output)} tokens`] : []),
    ...(s.context > 0 ? [`context ${formatCount(s.context)}`] : []),
    ...(models.length ? [models.join(" + ")] : []),
    ...(s.tools > 0 ? [plural(s.tools, "tool")] : []),
    ...(agents.length > 0 && !turn.notification ? [plural(agents.length, "agent")] : []),
    ...(files.length ? [`files ${[...(created ? [`+${created}`] : []), ...(changed ? [`~${changed}`] : [])].join(" ")}`, `lines +${s.added} −${s.removed}`] : []),
  ];
  return parts.length ? parts.join(" · ") : undefined;
}

/** What a turn is: a prompt, or one of the entries the parser makes a turn of. */
export function turnKind(turn: Turn): "prompt" | "start" | "notification" | "compaction" | "continuation" {
  if (turn.continuation) return "continuation";
  if (turn.id === "start") return "start";
  if (turn.compacted) return "compaction";
  if (turn.notification) return "notification";
  return "prompt";
}

const agentsOf = (turn: Turn) => turn.blocks.flatMap((b) => (b.kind === "agent" ? [b.agent] : []));

/** Lines of a prompt's attachments other than images: @-mentions and IDE selections. */
function attachmentLines(turn: Turn): string[] {
  return (turn.attachments ?? []).flatMap((a) => {
    if (a.kind === "file" || a.kind === "directory") return [`@${code(a.path)}`];
    if (a.kind === "selection") return [`selection${a.lines !== undefined ? ` of ${plural(a.lines, "line")}` : ""}${a.file ? ` in ${code(a.file)}` : ""}`];
    return [];
  });
}

// --- Markdown ---------------------------------------------------------------------------------

/** The subagent's conversation as a document of its own. */
function agentDocument(agent: AgentRun, turns: Turn[], opts: { tools: ToolLevel; thinking: boolean }): string {
  const parts = [`# ◆ ${escapeMd(agentTitle(agent))}`, escapeMd(agentStatusLine(agent))];
  turns.forEach((t, i) => {
    parts.push(`## ${i === 0 ? "Task" : "Message"}`, quote(t.prompt));
    const body = boxesAsQuotes(turnMarkdown(t, { tools: opts.tools, thinking: opts.thinking, agents: true }));
    if (body) parts.push(body);
  });
  if (turns.length === 0 && agent.result) parts.push("## Result", agent.result);
  return parts.join("\n\n") + "\n";
}

/** The file name of a subagent's own document in `agents/`. */
const agentFileName = (agent: AgentRun, ext: string) => `agents/${slug(agent.type ?? "agent")}-${slug(agent.agentId ?? agent.id)}.${ext}`;

/** Two Markdown documents of a session, for reading (`markdown`) or as context for a language model (`llm`). */
export function sessionMarkdown(
  session: LoadedSession,
  opts: ExportOptions,
  format: "markdown" | "llm",
  images: ImageSource,
  now = new Date(),
): { text: string; files: ExportFile[] } {
  const llm = format === "llm";
  const s = session.summary;
  const attachments = new Attachments(images);
  const files: ExportFile[] = [];
  const tools = llm ? atMost(opts.tools, "compact") : opts.tools;
  const parts: string[] = [];
  const title = exportTitle(session);

  // The head: what the session is and how to go on with it.
  const span = spanText(s.start, s.end);
  const facts: [string, string | undefined][] = [
    ["Session", code(s.id) + (s.continues?.length ? ` (continues ${s.continues.map(code).join(", ")})` : "")],
    ["Project", s.cwd ? code(s.cwd) : undefined],
    ["Branch", s.branch ? code(s.branch) : undefined],
    ["Time", span],
    ...(llm
      ? []
      : ([
          ["Contents", [plural(s.prompts.length, "prompt"), plural(s.plans.length, "plan"), plural(s.agents?.length ?? 0, "agent"), plural(s.files.length, "changed file")].join(" · ")],
          ["Resume", code(`claude --resume ${s.id}`)],
          ["Exported", `${localTime(now.toISOString())} with cco ${VERSION}`],
        ] as [string, string][])),
  ];
  parts.push(`# ${escapeMd(title)}`, facts.flatMap(([k, v]) => (v ? [`- **${k}:** ${v}`] : [])).join("\n"));

  // Subagents written out in full get a document each, linked from where they ran.
  const agentDocs = new Map<AgentRun, string>();
  if (opts.agents === "full") {
    for (const agent of session.agents) {
      const turns = loadSubagent(session, agent);
      if (!turns) continue;
      const name = agentFileName(agent, "md");
      agentDocs.set(agent, name);
      files.push({ name, data: () => agentDocument(agent, turns, { tools, thinking: opts.thinking }) });
    }
  }

  const last = session.turns.at(-1);
  session.turns.forEach((turn, i) => {
    const n = i + 1;
    const kind = turnKind(turn);
    const when = localTime(turn.timestamp);
    const out: string[] = [];
    if (llm) {
      if (kind === "prompt") out.push(`## User${when ? ` (${when})` : ""}`, turn.prompt);
      else if (kind === "notification") out.push(`## Notification${when ? ` (${when})` : ""}`, turn.prompt);
      else if (kind === "continuation") out.push(`## Session continued`, escapeMd(turn.prompt));
      else if (kind === "compaction") out.push(`## Conversation compacted`);
    } else {
      const label =
        kind === "notification"
          ? `↩ ${escapeMd(turn.prompt.split("\n")[0]!)}`
          : kind === "continuation"
            ? `⤷ ${escapeMd(turn.prompt)}`
            : kind === "compaction"
              ? "⟳ Compacted automatically"
              : kind === "start"
                ? escapeMd(turn.prompt)
                : `❯ Prompt${turn.queued ? " (queued)" : ""}`;
      out.push(`## ${n} · ${label}${when ? ` · ${when}` : ""}`);
      if (kind === "prompt" || (kind === "notification" && turn.prompt.includes("\n"))) out.push(quote(turn.prompt));
    }
    const images = attachments.promptImages(turn, n);
    const extra = [...images.map((im) => (im.file ? `![${im.label}](${im.file})` : `[${im.label}]`)), ...attachmentLines(turn)];
    if (extra.length) out.push(extra.join("  \n"));
    if (!llm && opts.stats) {
      const stats = statsText(turn, agentsOf(turn));
      if (stats) out.push(`*${stats}*`);
    }
    if (llm && kind !== "compaction") out.push("## Claude");
    const answerAt = out.length;

    // A report or a message from another agent comes first, Claude's reaction to it after it.
    if (turn.notification?.kind && turn.notification.result) {
      out.push(quote(`**${turn.notification.kind === "handback" ? "◆ Report" : "✉ Message"}**\n\n${turn.notification.result}`));
    }
    const shots = turnScreenshots(turn);
    let run: Block[] = [];
    const flush = () => {
      if (!run.length) return;
      const runTurn = { ...turn, blocks: run };
      const md = boxesAsQuotes(turnMarkdown(runTurn, { tools, thinking: opts.thinking, agents: false, browser: !llm, shots }));
      if (md) out.push(md);
      if (!llm) {
        const inRun = shots.filter((sh) => run.includes(sh.block));
        const links = inRun.flatMap((sh) => {
          const file = attachments.screenshot(turn, n, sh);
          return file ? [`![▣ ${sh.n}](${file})`] : [];
        });
        if (links.length) out.push(links.join("  \n"));
      }
      run = [];
    };
    for (const b of turn.blocks) {
      if (b.kind === "recap") {
        flush();
        if (!llm) out.push(quote(`**※ Recap**\n\n${b.text}`));
      } else if (b.kind === "compact") {
        flush();
        const info = compactText(b.info);
        out.push(`**⟳ Compact summary**${info ? ` · ${info}` : ""}`, b.text);
      } else if (b.kind === "agent") {
        flush();
        if (opts.agents === "none") continue;
        const a = b.agent;
        const doc = agentDocs.get(a);
        out.push(
          [
            `**◆ ${escapeMd(agentTitle(a))}**  \n${escapeMd(agentStatusLine(a))}`,
            ...(doc ? [`[Whole conversation](${doc})`] : []),
            ...(a.result ? [quote(`**Report**\n\n${a.result}`)] : []),
          ].join("\n\n"),
        );
      } else {
        run.push(b);
      }
    }
    flush();
    if (turn.interrupted) out.push(`*⊘ Interrupted by user${turn.interrupted === "tool" ? " during a tool call" : ""}*`);
    else if (turn === last && !turn.done && kind === "prompt") out.push("*… still running when exported*");
    if (llm && out.length === answerAt) out.pop();
    parts.push(out.join("\n\n"));
  });

  if (session.plans.length) {
    const plans = session.plans.map((p, i) =>
      [`### Plan ${i + 1} · ${p.status}${p.timestamp ? ` · ${localTime(p.timestamp)}` : ""}`, ...(p.feedback ? [quote(p.feedback)] : []), p.text].join("\n\n"),
    );
    parts.push(`## Plans`, plans.join("\n\n"));
  }
  if (!llm && s.files.length) parts.push(`## Changed files`, s.files.map((f) => `- ${code(f)}`).join("\n"));
  return { text: parts.join("\n\n") + "\n", files: [...attachments.files, ...files] };
}

// --- JSON -------------------------------------------------------------------------------------

/** Version of the JSON document's shape; raised when fields change their meaning. */
export const JSON_SCHEMA_VERSION = 1;

/** A block in the JSON export, as far as the options let it in. */
function jsonBlock(
  b: Block,
  opts: ExportOptions,
  turn: Turn,
  n: number,
  attachments: Attachments,
  shots: Screenshot[],
  agentDocs: Map<AgentRun, string>,
): unknown[] {
  switch (b.kind) {
    case "text":
      return [{ type: "text", text: b.text }];
    case "thinking":
      return opts.thinking ? [{ type: "thinking", text: b.text }] : [];
    case "recap":
      return [{ type: "recap", text: b.text }];
    case "compact":
      return [{ type: "compact", text: b.text, ...(b.info ? { info: b.info } : {}) }];
    case "agent": {
      if (opts.agents === "none") return [];
      const { transcript: _, ...agent } = b.agent;
      return [{ type: "agent", agent: { ...agent, ...(agentDocs.has(b.agent) ? { conversation: agentDocs.get(b.agent) } : {}) } }];
    }
    case "tool": {
      if (opts.tools === "off" && b.name !== "AskUserQuestion") return [];
      const screenshots = shots
        .filter((s) => s.block === b)
        .flatMap((s) => {
          const file = attachments.screenshot(turn, n, s);
          return file ? [file] : [];
        });
      return [
        {
          type: "tool",
          id: b.id,
          name: b.name,
          ...(opts.tools === "full" || b.name === "AskUserQuestion" ? { input: b.input } : {}),
          ...(b.outcome ? { outcome: opts.tools === "full" ? b.outcome : { status: b.outcome.status, summary: b.outcome.summary, answers: b.outcome.answers } } : {}),
          ...(screenshots.length ? { screenshots } : {}),
        },
      ];
    }
  }
}

/** The JSON document of a session: what it is, its turns with their blocks, its plans and agents. */
export function sessionJson(session: LoadedSession, opts: ExportOptions, images: ImageSource, now = new Date()): { text: string; files: ExportFile[] } {
  const s = session.summary;
  const attachments = new Attachments(images);
  const files: ExportFile[] = [];
  const agentDocs = new Map<AgentRun, string>();
  if (opts.agents === "full") {
    for (const agent of session.agents) {
      const turns = loadSubagent(session, agent);
      if (!turns) continue;
      const name = agentFileName(agent, "json");
      agentDocs.set(agent, name);
      files.push({
        name,
        data: () =>
          JSON.stringify(
            turns.map((t) => ({ prompt: t.prompt, timestamp: t.timestamp, blocks: t.blocks.flatMap((b) => jsonBlock(b, { ...opts, agents: "reports" }, t, 0, attachments, [], new Map())) })),
            null,
            2,
          ),
      });
    }
  }
  const turns = session.turns.map((turn, i) => {
    const n = i + 1;
    const shots = turnScreenshots(turn);
    const images = attachments.promptImages(turn, n);
    let image = 0;
    const attached = (turn.attachments ?? []).map((a) => (a.kind === "image" ? { kind: "image", ...(images[image++]?.file ? { file: images[image - 1]!.file } : {}) } : a));
    return {
      id: turn.id,
      kind: turnKind(turn),
      timestamp: turn.timestamp,
      prompt: turn.prompt,
      ...(turn.queued ? { queued: true } : {}),
      done: turn.done === true,
      ...(turn.interrupted ? { interrupted: turn.interrupted } : {}),
      ...(attached.length ? { attachments: attached } : {}),
      ...(turn.notification ? { notification: turn.notification } : {}),
      ...(turn.continuation ? { continuation: turn.continuation } : {}),
      ...(opts.stats && turn.stats ? { stats: turn.stats } : {}),
      blocks: turn.blocks.flatMap((b) => jsonBlock(b, opts, turn, n, attachments, shots, agentDocs)),
    };
  });
  const doc = {
    format: "cco-session-export",
    version: JSON_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    cco: VERSION,
    options: opts,
    session: {
      id: s.id,
      ...(s.continues?.length ? { continues: s.continues } : {}),
      title: exportTitle(session),
      cwd: s.cwd,
      branch: s.branch,
      start: s.start,
      end: s.end,
      lastActive: lastActive(s),
      resume: `claude --resume ${s.id}`,
      files: s.files,
    },
    turns,
    plans: session.plans,
    ...(opts.agents !== "none"
      ? {
          agents: session.agents.map((agent) => {
            const { transcript: _, ...a } = agent;
            const conversation = agentDocs.get(agent);
            return conversation ? { ...a, conversation } : a;
          }),
        }
      : {}),
  };
  return { text: JSON.stringify(doc, null, 2) + "\n", files: [...attachments.files, ...files] };
}

// --- cco's own data of a session --------------------------------------------------------------

/** What cco keeps about a session besides the transcript: marks, scroll positions, view and placement. */
export interface SessionCcoData {
  favorites: { turns: string[]; plans: string[]; sessions: string[] };
  positions: Partial<Record<PositionList, Record<string, number>>>;
  view?: string;
  placement?: string;
}

/** The scroll positions of `list` whose key is one of `ids` or starts with one and `#`. */
function scrollOf(cwd: string, list: PositionList, ids: Set<string>): Record<string, number> {
  const scroll = readPositions(cwd, list).scroll;
  return Object.fromEntries(Object.entries(scroll).filter(([key]) => ids.has(key) || ids.has(key.split("#")[0]!)));
}

/** cco's data of the session, from its project (`cwd`) and, for its session mark, the viewer's (`viewerCwd`). */
export function sessionCcoData(session: LoadedSession, cwd: string, viewerCwd: string): SessionCcoData {
  const s = session.summary;
  const sessionIds = new Set([s.id, ...(s.continues ?? [])]);
  const turnIds = new Set(session.turns.map((t) => t.id));
  const planIds = new Set(session.plans.map((p) => p.id));
  const marked = new Set([...readFavorites(cwd, "sessions"), ...readFavorites(viewerCwd, "sessions")]);
  return {
    favorites: {
      turns: readFavorites(cwd, "turns").filter((id) => turnIds.has(id)),
      plans: readFavorites(cwd, "plans").filter((id) => planIds.has(id)),
      sessions: [...sessionIds].filter((id) => marked.has(id)),
    },
    positions: {
      chat: scrollOf(cwd, "chat", turnIds),
      plan: scrollOf(cwd, "plan", planIds),
      sessions: { ...scrollOf(viewerCwd, "sessions", sessionIds), ...scrollOf(cwd, "sessions", sessionIds) },
    },
    view: readSessionView(cwd, s.id),
    placement: readSessionPlacement(cwd, s.id),
  };
}

/** The session id of a transcript path. */
export const idOf = (path: string) => basename(path, ".jsonl");
