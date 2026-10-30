import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { pastedNumbers, type AttachmentItem } from "../attachments.js";
import type { PendingRequest } from "../remote/pending.js";
import { imageAction, isBrowserTool } from "./chrome.js";
import { IncrementalFile } from "./incremental.js";
import { claudeDir, inClaudeDir, projectDir } from "./locate.js";
import { isCommand, TranscriptParser, type AgentStatus, type Plan } from "./parse.js";

/** What the Sessions view shows about one session. */
export interface SessionSummary {
  id: string;
  path: string;
  /** Name given with /rename, if any. */
  title?: string;
  /** The title Claude Code gave it itself (`ai-title`), which it shows when it has no /rename one. */
  aiTitle?: string;
  /** The name its Claude Code shows while it runs (`~/.claude/sessions`), added by the views that know it. */
  name?: string;
  prompts: { text: string; timestamp?: string }[];
  plans: Plan[];
  /** Files Claude edited or wrote, in the order first touched. */
  files: string[];
  /** Subagents Claude started; missing in summaries stored before they were recorded (trash manifests). */
  agents?: SessionAgent[];
  /** Dynamic workflows Claude started; missing in summaries stored before they were recorded. */
  workflows?: SessionWorkflow[];
  /**
   * What came with the prompts and what tools returned, oldest first: pasted
   * images, @-mentions (one per path), images and PDFs of tool results; no
   * image data. Missing in summaries stored before they were recorded.
   */
  attachments?: AttachmentItem[];
  /** Git branch of the last entry that recorded one. */
  branch?: string;
  /** Working directory Claude Code was started in (the first entry that recorded one). */
  cwd?: string;
  /** First and last timestamp in the transcript. */
  start?: string;
  end?: string;
  /** When its transcript was last written (ISO); of a chain, the latest of its transcripts. Missing for text fed directly (tests). */
  modified?: string;
  /** The session id this one went on in (`continued-in`); such a session is shown merged into that one. */
  continuedIn?: string;
  /** Ids of the sessions merged into this one, which it continued from, oldest first. */
  continues?: string[];
  /** The config folder of another account the session belongs to; missing for this viewer's own. */
  account?: string;
  /** Ran in the background: started with `claude -p` or the SDK (`sdk`), or by the Claude Code daemon (`daemon`). */
  background?: SessionBackground;
  /** The ids claude.ai gave the session while Remote Control connected it (`bridge-session` entries, `cse_…`). */
  bridgeIds?: string[];
  /** A Remote Control session read from claude.ai, not from a transcript on this machine (`path` is only a stand-in). */
  remote?: RemoteInfo;
}

/** What claude.ai tells about a remote session, besides what a transcript would hold. */
export interface RemoteInfo {
  /** `idle`, `running` or `requires_action`. */
  workerStatus?: string;
  connectionStatus?: string;
  /** `bridge` for a Remote Control session. */
  kind?: string;
  /** How many prompts claude.ai counts; the summary holds them only once its events are `loaded`. */
  userMessages?: number;
  loaded: boolean;
  /** Why its events could not be read. */
  error?: string;
  /** Older events were left out of what was read. */
  truncated?: boolean;
  /** Kinds of event with no counterpart in a transcript, by count. */
  unknown?: Record<string, number>;
  /** Ids named in the session's data: a session of this machine with one of them is the same. */
  refs?: string[];
  /** What the worker waits for, while `requires_action`: the list answers it from here. */
  pending?: PendingRequest;
}

/** How a background session was run: `claude -p` or the SDK (`entrypoint` `sdk-cli`), or the daemon (`sessionKind` `bg`). */
export type SessionBackground = "sdk" | "daemon";

/** What the overview keeps of a subagent. */
export interface SessionAgent {
  description: string;
  type?: string;
  status: AgentStatus;
  started?: string;
  durationMs?: number;
}

/** A workflow as its launch and its notification tell it; its agents are counted, not read. */
export interface SessionWorkflow {
  /** The Workflow tool call id. */
  id: string;
  name?: string;
  description?: string;
  status: AgentStatus;
  runId?: string;
  resumeOf?: string;
  started?: string;
  durationMs?: number;
  agents?: number;
  tokens?: number;
}

/** Tools whose input names a file Claude changed. */
const EDIT_TOOLS: Record<string, string> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

interface RawEntry {
  type?: string;
  message?: { content?: unknown };
  toolUseResult?: unknown;
  timestamp?: string;
  gitBranch?: string;
  cwd?: string;
  customTitle?: string;
  aiTitle?: string;
  bridgeSessionId?: string;
  isSidechain?: boolean;
  entrypoint?: string;
  sessionKind?: string;
}

/**
 * Reads one transcript incrementally: each update only parses the bytes
 * appended since the last one, so the growing active session stays cheap.
 */
export class SessionReader {
  private file: IncrementalFile;
  private parser = new TranscriptParser();
  private title?: string;
  private aiTitle?: string;
  private branch?: string;
  private cwd?: string;
  private start?: string;
  private end?: string;
  private files: string[] = [];
  private background?: SessionBackground;
  private bridgeIds: string[] = [];
  /** Images and PDFs of tool results, in order. */
  private results: AttachmentItem[] = [];
  /** What names a call's images until its result comes: the file a Read read, a browser action, an MCP tool. */
  private callLabels = new Map<string, string>();
  private summary?: SessionSummary;

  constructor(readonly path: string) {
    this.file = new IncrementalFile(path, (line) => this.consume(line), () => this.reset());
  }

  /** Reads what was appended since the last call; returns the current summary. */
  update(): SessionSummary {
    if (this.file.update() || !this.summary) this.summary = this.summarize();
    return this.summary;
  }

  /** Feeds transcript text directly (used by tests). */
  push(text: string): SessionSummary {
    this.file.push(text);
    this.summary = this.summarize();
    return this.summary;
  }

  private reset(): void {
    this.parser = new TranscriptParser();
    this.title = this.aiTitle = this.branch = this.cwd = this.start = this.end = this.background = undefined;
    this.bridgeIds = [];
    this.files = [];
    this.results = [];
    this.callLabels.clear();
  }

  private consume(line: string): void {
    let entry: RawEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry.type === "custom-title" && entry.customTitle?.trim()) this.title = entry.customTitle.trim();
    if (entry.type === "ai-title" && entry.aiTitle?.trim() && !entry.isSidechain) this.aiTitle = entry.aiTitle.trim();
    // Remote Control connected it: claude.ai lists it under this id.
    if (entry.type === "bridge-session" && entry.bridgeSessionId && !this.bridgeIds.includes(entry.bridgeSessionId)) this.bridgeIds.push(entry.bridgeSessionId);
    if (!entry.isSidechain) {
      if (entry.gitBranch) this.branch = entry.gitBranch;
      if (entry.cwd) this.cwd ??= entry.cwd;
      // The daemon may run a session started interactively (sent to the background): it counts from then on.
      if (entry.sessionKind === "bg") this.background = "daemon";
      else if (entry.entrypoint === "sdk-cli") this.background ??= "sdk";
      if (entry.timestamp) {
        this.start ??= entry.timestamp;
        this.end = entry.timestamp;
      }
    }
    try {
      this.parser.push(line + "\n");
    } catch {
      // An entry in a shape the parser does not know must not stop the overview.
    }
    this.takeBlocks();
    // Most lines hold no image: only those that might are looked at.
    if (!entry.isSidechain && line.includes('"tool_result"') && (line.includes('"image"') || line.includes('"document"'))) this.takeResultFiles(entry);
  }

  /** Notes the images and PDFs of the tool results in `entry` (their data stays in the transcript). */
  private takeResultFiles(entry: RawEntry): void {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    const prompt = this.parser.turns.at(-1)?.prompt;
    for (const block of content as { type?: string; tool_use_id?: string; content?: unknown }[]) {
      if (block?.type !== "tool_result" || !block.tool_use_id || !Array.isArray(block.content)) continue;
      const read = (entry.toolUseResult as { file?: { filePath?: unknown } } | undefined)?.file?.filePath;
      const label = typeof read === "string" ? baseName(read) : this.callLabels.get(block.tool_use_id);
      this.callLabels.delete(block.tool_use_id);
      (block.content as { type?: string }[]).forEach((b, index) => {
        if (b?.type !== "image" && b?.type !== "document") return;
        const kind = b.type === "document" ? "pdf" : "image";
        this.results.push({
          kind,
          n: this.results.filter((r) => r.kind === kind).length + 1,
          toolUseId: block.tool_use_id!,
          index,
          label: label ?? "tool result",
          transcript: this.path,
          ...(entry.timestamp ? { at: entry.timestamp } : {}),
          ...(prompt ? { prompt: excerpt(prompt) } : {}),
        });
      });
    }
  }

  /**
   * Collects the changed files from the blocks the last line added and drops
   * the blocks: the overview needs no answers or thinking, and keeping them
   * for every session of every project would cost hundreds of MB.
   */
  private takeBlocks(): void {
    const turn = this.parser.turns.at(-1);
    if (!turn?.blocks.length) return;
    for (const b of turn.blocks) {
      // Only these tools return images: what names them is kept until their result comes.
      if (b.kind === "tool" && b.id && (b.name === "Read" || b.name.startsWith("mcp__"))) {
        const path = (b.input as Record<string, unknown> | undefined)?.file_path;
        this.callLabels.set(b.id, typeof path === "string" ? baseName(path) : isBrowserTool(b.name) ? imageAction(b.name, b.input, undefined) : toolName(b.name));
      }
      if (b.kind !== "tool" || !EDIT_TOOLS[b.name]) continue;
      const file = (b.input as Record<string, unknown> | undefined)?.[EDIT_TOOLS[b.name]];
      if (typeof file === "string" && !this.files.includes(file)) this.files.push(file);
    }
    turn.blocks.length = 0;
  }

  private summarize(): SessionSummary {
    return {
      id: basename(this.path, ".jsonl"),
      path: this.path,
      title: this.title,
      ...(this.aiTitle && { aiTitle: this.aiTitle }),
      // Task notifications and where the session went on are turns too, but not prompts.
      prompts: this.parser.turns
        .filter((t) => t.id !== "start" && !t.notification && !t.continuation && !t.compacted)
        .map((t) => ({ text: t.prompt, timestamp: t.timestamp })),
      plans: this.parser.plans.map((p) => ({ ...p })),
      files: [...this.files],
      attachments: this.attachments(),
      agents: this.parser.agents.map(({ description, type, status, started, durationMs }) => ({
        description,
        type,
        status,
        started,
        durationMs,
      })),
      workflows: this.parser.workflows.map(({ id, name, description, status, runId, resumeOf, started, durationMs, agentCount, tokens }) => ({
        id,
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        status,
        ...(runId !== undefined && { runId }),
        ...(resumeOf !== undefined && { resumeOf }),
        ...(started !== undefined && { started }),
        ...(durationMs !== undefined && { durationMs }),
        ...(agentCount !== undefined && { agents: agentCount }),
        ...(tokens !== undefined && { tokens }),
      })),
      branch: this.branch,
      cwd: this.cwd,
      start: this.start,
      end: this.end,
      modified: this.file.modified !== undefined ? new Date(this.file.modified).toISOString() : undefined,
      continuedIn: this.parser.continuedIn,
      ...(this.background && { background: this.background }),
      ...(this.bridgeIds.length > 0 && { bridgeIds: [...this.bridgeIds] }),
    };
  }

  /** The prompts' pasted images and @-mentions (one entry per path) with the images and PDFs of tool results, by time. */
  private attachments(): AttachmentItem[] {
    const items: AttachmentItem[] = [];
    const mentions = new Map<string, Extract<AttachmentItem, { kind: "file" | "directory" }>>();
    for (const t of this.parser.turns) {
      const list = t.attachments ?? [];
      if (list.length === 0) continue;
      const at = t.timestamp ? { at: t.timestamp } : {};
      const numbers = pastedNumbers(t.prompt, list.filter((a) => a.kind === "image").length);
      let index = 0;
      for (const a of list) {
        if (a.kind === "image") {
          const i = index++;
          items.push({ kind: "pasted", n: numbers[i], uuid: t.id, index: i, ...(a.path ? { upload: a.path } : {}), transcript: this.path, ...at, prompt: excerpt(t.prompt) });
        } else if (a.kind === "file" || a.kind === "directory") {
          const full = a.full ?? (this.cwd && !isAbsolute(a.path) ? join(this.cwd, a.path) : a.path);
          const seen = mentions.get(full);
          if (seen) {
            if (!seen.uuids?.includes(t.id)) seen.uuids = [...(seen.uuids ?? []), t.id];
            continue;
          }
          const item = { kind: a.kind, path: a.path, full, ...at, uuids: [t.id] };
          mentions.set(full, item);
          items.push(item);
        }
      }
    }
    return byTime([...items, ...this.results.map((r) => ({ ...r }))]);
  }
}

/** The first line of a prompt, cut to a length a list row can show. */
const excerpt = (prompt: string) => {
  const first = prompt.split("\n").find((l) => l.trim())?.trim() ?? "";
  return first.length > 80 ? first.slice(0, 79) + "…" : first;
};

/** The file name of a path in either spelling. */
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** "claude-in-chrome · navigate" for "mcp__claude-in-chrome__navigate". */
const toolName = (name: string) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
};

/** `items` by time, those without one where they came. */
const byTime = (items: AttachmentItem[]) =>
  items.map((item, i) => ({ item, i })).sort((a, b) => (a.item.at && b.item.at ? a.item.at.localeCompare(b.item.at) : 0) || a.i - b.i).map((x) => x.item);

/** What makes an attachment the same in two transcripts of a chain (the later starts with copies of the last entries). */
function attachmentKey(a: AttachmentItem): string {
  if (a.kind === "pasted") return `p ${a.uuid} ${a.index}`;
  if ("toolUseId" in a) return `t ${a.toolUseId} ${a.index}`;
  return `f ${a.full}`;
}

/** The attachments of two transcripts of a chain as one list: each once, mentions of a path joined, tool images numbered through. */
function mergeAttachments(earlier: AttachmentItem[] | undefined, later: AttachmentItem[] | undefined): AttachmentItem[] | undefined {
  if (!earlier && !later) return undefined;
  const byKey = new Map<string, AttachmentItem>();
  for (const a of [...(earlier ?? []), ...(later ?? [])]) {
    const key = attachmentKey(a);
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { ...a });
    else if ((seen.kind === "file" || seen.kind === "directory") && (a.kind === "file" || a.kind === "directory"))
      seen.uuids = [...new Set([...(seen.uuids ?? []), ...(a.uuids ?? [])])];
  }
  const count = { image: 0, pdf: 0 };
  return byTime([...byKey.values()]).map((a) => (a.kind === "image" || a.kind === "pdf" ? { ...a, n: ++count[a.kind] } : a));
}

const promptKey = (p: { text: string; timestamp?: string }) => `${p.timestamp ?? ""} ${p.text}`;

/** `later` with `earlier`, the session it continued from, merged in: one session to the user. */
function mergeSessions(earlier: SessionSummary, later: SessionSummary): SessionSummary {
  // The later transcript starts with copies of the last entries, so some prompts are in both.
  const prompts = new Set(earlier.prompts.map(promptKey));
  const plans = new Set(earlier.plans.map((p) => p.id));
  const agentKey = (a: SessionAgent) => `${a.started ?? ""} ${a.description}`;
  const agents = new Set((earlier.agents ?? []).map(agentKey));
  return {
    ...later,
    title: later.title ?? earlier.title,
    aiTitle: later.aiTitle ?? earlier.aiTitle,
    prompts: [...earlier.prompts, ...later.prompts.filter((p) => !prompts.has(promptKey(p)))],
    plans: [...earlier.plans, ...later.plans.filter((p) => !plans.has(p.id))],
    files: [...new Set([...earlier.files, ...later.files])],
    agents: [...(earlier.agents ?? []), ...(later.agents ?? []).filter((a) => !agents.has(agentKey(a)))],
    workflows: [...(earlier.workflows ?? []), ...(later.workflows ?? []).filter((w) => !(earlier.workflows ?? []).some((e) => e.id === w.id))],
    attachments: mergeAttachments(earlier.attachments, later.attachments),
    branch: later.branch ?? earlier.branch,
    cwd: earlier.cwd ?? later.cwd,
    background: later.background ?? earlier.background,
    ...((earlier.bridgeIds || later.bridgeIds) && { bridgeIds: [...new Set([...(earlier.bridgeIds ?? []), ...(later.bridgeIds ?? [])])] }),
    start: earlier.start ?? later.start,
    end: later.end ?? earlier.end,
    modified: [earlier.modified, later.modified].filter((m): m is string => m !== undefined).sort().at(-1),
    continues: [...(earlier.continues ?? []), earlier.id, ...(later.continues ?? [])],
  };
}

/**
 * Merges each session that went on under another id (`continuedIn`) into
 * that one, which keeps its id: `claude --resume` takes the later one.
 */
export function mergeContinued(sessions: SessionSummary[]): SessionSummary[] {
  const key = (s: SessionSummary, id = s.id) => join(dirname(s.path), id);
  const byKey = new Map(sessions.map((s) => [key(s), s]));
  // Oldest first, so a chain of several merges forward into its last session.
  for (const s of [...sessions].sort(byStart)) {
    if (!s.continuedIn) continue;
    const own = key(s);
    const next = key(s, s.continuedIn);
    const earlier = byKey.get(own);
    const later = byKey.get(next);
    if (!earlier || !later || own === next) continue;
    byKey.set(next, mergeSessions(earlier, later));
    byKey.delete(own);
  }
  return [...byKey.values()];
}

/** Transcripts of one project (`cwd`) or, without it, of all projects. */
export function transcriptFiles(cwd?: string): string[] {
  const root = join(claudeDir(), "projects");
  let dirs: string[];
  try {
    dirs = cwd ? [projectDir(cwd)] : readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name));
  } catch {
    return [];
  }
  return dirs.flatMap((dir) => {
    try {
      return readdirSync(dir)
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => join(dir, n));
    } catch {
      return [];
    }
  });
}

/** `files` last written at or after `since` (epoch ms); all of them without it. */
export function writtenSince(files: string[], since: number | undefined): string[] {
  if (since === undefined) return files;
  return files.filter((f) => {
    try {
      return statSync(f).mtimeMs >= since;
    } catch {
      return false;
    }
  });
}

const byStart = (a: SessionSummary, b: SessionSummary) => (a.start ?? "").localeCompare(b.start ?? "");

/**
 * When the session was last worked in: when its transcripts were last written,
 * else its last entry. The Sessions list is sorted, dated and cut to its range
 * by it: any write (a prompt, Claude working, an import or a move) counts.
 */
export function lastActive(s: SessionSummary): string | undefined {
  return s.modified ?? s.end ?? s.start;
}

const byLastActive = (a: SessionSummary, b: SessionSummary) => (lastActive(a) ?? "").localeCompare(lastActive(b) ?? "");

/** Sessions of one project or of all, kept up to date by re-reading only files that changed. */
export class SessionIndex {
  private readers = new Map<string, SessionReader>();

  /** `account`: the config folder of another account, whose sessions this index reads and marks with it. */
  constructor(private readonly account?: string) {}

  /** Runs `fn` in the index's config folder. */
  private inFolder<T>(fn: () => T): T {
    return this.account ? inClaudeDir(this.account, fn) : fn();
  }

  /**
   * Sessions with work in them (see `hasWork`), by `lastActive` oldest first, of the project
   * `cwd` or, without it, of all projects. Yields between files so a first
   * scan over many large transcripts does not freeze the viewer, and reports
   * what it has so far through `onProgress`. With `since` (epoch ms), only
   * transcripts written since then are read: the sessions of a range of days
   * are exactly those, since a session counts from its last write.
   */
  async scan(
    cwd?: string,
    onProgress?: (sessions: SessionSummary[], done: number, total: number) => void,
    since?: number,
  ): Promise<SessionSummary[]> {
    const all = this.inFolder(() => transcriptFiles(cwd));
    const files = writtenSince(all, since);
    const summaries: SessionSummary[] = [];
    const { account } = this;
    // Continued sessions are merged before the filter: one part alone may hold only slash commands.
    const sessions = () => {
      const found = mergeContinued(summaries).filter(hasWork).sort(byLastActive);
      return account ? found.map((s) => ({ ...s, account })) : found;
    };
    let reported = Date.now();
    for (const [i, path] of files.entries()) {
      let reader = this.readers.get(path);
      if (!reader) this.readers.set(path, (reader = new SessionReader(path)));
      summaries.push(reader.update());
      if (onProgress && Date.now() - reported > 250) {
        reported = Date.now();
        onProgress(sessions(), i + 1, files.length);
      }
      await new Promise((r) => setImmediate(r));
    }
    // Forget transcripts that are gone (deleted, moved to the trash).
    const present = new Set(all);
    const scanned = cwd ? this.inFolder(() => projectDir(cwd)) : undefined;
    for (const path of this.readers.keys()) if (!present.has(path) && (!scanned || path.startsWith(scanned))) this.readers.delete(path);
    return sessions();
  }
}

/**
 * Bookkeeping files have no prompt at all; a session that only ran slash
 * commands such as /resume or `!` commands and changed nothing is left out as well.
 */
function hasWork(s: SessionSummary): boolean {
  return s.prompts.some((p) => !isCommand(p.text)) || s.plans.length > 0 || s.files.length > 0;
}

/** Whether `path` lies inside `cwd`. */
export function insideProject(path: string, cwd: string): boolean {
  const rel = isAbsolute(path) ? relative(cwd, path) : path;
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** `path` relative to `cwd` when it lies inside it, else with the home directory as ~; forward slashes. */
export function displayPath(path: string, cwd: string): string {
  const home = homedir();
  let shown = path;
  if (insideProject(path, cwd)) shown = isAbsolute(path) ? relative(cwd, path) : path;
  else if (path.toLowerCase().startsWith(home.toLowerCase())) shown = "~" + path.slice(home.length);
  return shown.replace(/\\/g, "/");
}

/** Wall-clock time between two timestamps, e.g. "2 h 05 min", "12 min" or "< 1 min". */
export function formatDuration(start?: string, end?: string): string | undefined {
  if (!start || !end) return undefined;
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60000);
  if (!(minutes >= 1)) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}
