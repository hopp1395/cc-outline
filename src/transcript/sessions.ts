import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { IncrementalFile } from "./incremental.js";
import { claudeDir, projectDir } from "./locate.js";
import { isCommand, TranscriptParser, type AgentStatus, type Plan } from "./parse.js";

/** What the Sessions view shows about one session. */
export interface SessionSummary {
  id: string;
  path: string;
  /** Name given with /rename, if any. */
  title?: string;
  prompts: { text: string; timestamp?: string }[];
  plans: Plan[];
  /** Files Claude edited or wrote, in the order first touched. */
  files: string[];
  /** Subagents Claude started; missing in summaries stored before they were recorded (trash manifests). */
  agents?: SessionAgent[];
  /** Git branch of the last entry that recorded one. */
  branch?: string;
  /** Working directory Claude Code was started in (the first entry that recorded one). */
  cwd?: string;
  /** First and last timestamp in the transcript. */
  start?: string;
  end?: string;
  /** The session id this one went on in (`continued-in`); such a session is shown merged into that one. */
  continuedIn?: string;
  /** Ids of the sessions merged into this one, which it continued from, oldest first. */
  continues?: string[];
}

/** What the overview keeps of a subagent. */
export interface SessionAgent {
  description: string;
  type?: string;
  status: AgentStatus;
  started?: string;
  durationMs?: number;
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
  timestamp?: string;
  gitBranch?: string;
  cwd?: string;
  customTitle?: string;
  isSidechain?: boolean;
}

/**
 * Reads one transcript incrementally: each update only parses the bytes
 * appended since the last one, so the growing active session stays cheap.
 */
export class SessionReader {
  private file: IncrementalFile;
  private parser = new TranscriptParser();
  private title?: string;
  private branch?: string;
  private cwd?: string;
  private start?: string;
  private end?: string;
  private files: string[] = [];
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
    this.title = this.branch = this.cwd = this.start = this.end = undefined;
    this.files = [];
  }

  private consume(line: string): void {
    let entry: RawEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry.type === "custom-title" && entry.customTitle?.trim()) this.title = entry.customTitle.trim();
    if (!entry.isSidechain) {
      if (entry.gitBranch) this.branch = entry.gitBranch;
      if (entry.cwd) this.cwd ??= entry.cwd;
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
      // Task notifications are turns too, but not prompts.
      prompts: this.parser.turns
        .filter((t) => t.id !== "start" && !t.notification)
        .map((t) => ({ text: t.prompt, timestamp: t.timestamp })),
      plans: this.parser.plans.map((p) => ({ ...p })),
      files: [...this.files],
      agents: this.parser.agents.map(({ description, type, status, started, durationMs }) => ({
        description,
        type,
        status,
        started,
        durationMs,
      })),
      branch: this.branch,
      cwd: this.cwd,
      start: this.start,
      end: this.end,
      continuedIn: this.parser.continuedIn,
    };
  }
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
    prompts: [...earlier.prompts, ...later.prompts.filter((p) => !prompts.has(promptKey(p)))],
    plans: [...earlier.plans, ...later.plans.filter((p) => !plans.has(p.id))],
    files: [...new Set([...earlier.files, ...later.files])],
    agents: [...(earlier.agents ?? []), ...(later.agents ?? []).filter((a) => !agents.has(agentKey(a)))],
    branch: later.branch ?? earlier.branch,
    cwd: earlier.cwd ?? later.cwd,
    start: earlier.start ?? later.start,
    end: later.end ?? earlier.end,
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

const byStart = (a: SessionSummary, b: SessionSummary) => (a.start ?? "").localeCompare(b.start ?? "");

/** Sessions of one project or of all, kept up to date by re-reading only files that changed. */
export class SessionIndex {
  private readers = new Map<string, SessionReader>();

  /**
   * Sessions with work in them (see `hasWork`), oldest first, of the project
   * `cwd` or, without it, of all projects. Yields between files so a first
   * scan over many large transcripts does not freeze the viewer, and reports
   * what it has so far through `onProgress`.
   */
  async scan(
    cwd?: string,
    onProgress?: (sessions: SessionSummary[], done: number, total: number) => void,
  ): Promise<SessionSummary[]> {
    const files = transcriptFiles(cwd);
    const summaries: SessionSummary[] = [];
    // Continued sessions are merged before the filter: one part alone may hold only slash commands.
    const sessions = () => mergeContinued(summaries).filter(hasWork).sort(byStart);
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
    const present = new Set(files);
    for (const path of this.readers.keys()) if (!present.has(path) && (!cwd || path.startsWith(projectDir(cwd)))) this.readers.delete(path);
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
