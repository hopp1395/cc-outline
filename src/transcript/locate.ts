import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ActiveSession {
  session_id: string;
  transcript_path: string;
  cwd: string;
  updated: string;
  /** Set when the Claude Code session exited; a running viewer closes itself. */
  ended?: boolean;
}

export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Claude Code names project folders after the cwd with every non-alphanumeric char replaced by "-". */
export function projectSlug(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

export function projectDir(cwd: string): string {
  return join(claudeDir(), "projects", projectSlug(cwd));
}

/**
 * Claude Code creates small bookkeeping files per start (e.g. only a
 * "bridge-session" line). Large files are assumed to hold a conversation.
 */
function hasMessages(path: string, size: number): boolean {
  if (size > 64 * 1024) return true;
  const text = readFileSync(path, "utf8");
  return text.includes('"type":"user"') || text.includes('"type":"assistant"');
}

/** Most recently modified transcript of the project that contains messages, if any. */
export function findLatestTranscript(cwd: string): string | undefined {
  const dir = projectDir(cwd);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const candidates = names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const path = join(dir, name);
      const { mtimeMs, size } = statSync(path);
      return { path, mtimeMs, size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.find((c) => hasMessages(c.path, c.size))?.path;
}

export function transcriptForSession(cwd: string, sessionId: string): string {
  return join(projectDir(cwd), `${sessionId}.jsonl`);
}

/** Per-project state files live in ~/.claude/cco so parallel projects don't clash. */
function stateFile(cwd: string, suffix: string): string {
  return join(claudeDir(), "cco", `${projectSlug(cwd)}${suffix}.json`);
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Writes via rename so watchers never see a half-written file. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(join(claudeDir(), "cco"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/** Session state written by the hook. */
export function activeFile(cwd: string): string {
  return stateFile(cwd, "");
}

/**
 * Registration of the running viewer (pid). With `claudePid` the viewer
 * belongs to that Claude Code process; without, to the project (older setup).
 */
export function viewerFile(cwd: string, claudePid?: number): string {
  return stateFile(cwd, claudePid ? `.viewer-${claudePid}` : ".viewer");
}

/** Requests from `cco open` to a running viewer (e.g. switch view). */
export function controlFile(cwd: string, claudePid?: number): string {
  return stateFile(cwd, claudePid ? `.control-${claudePid}` : ".control");
}

/**
 * The session of one Claude Code process, written by the hook. Unlike the
 * project-wide active session, another Claude Code in the same project does
 * not overwrite it, so a viewer follows the session of its own pane.
 */
export function claudeFile(cwd: string, claudePid: number): string {
  return stateFile(cwd, `.claude-${claudePid}`);
}

/** State files of the project whose name continues with `prefix`, e.g. ".viewer-". */
export function projectStateFiles(cwd: string, prefix: string): string[] {
  const dir = join(claudeDir(), "cco");
  const start = `${projectSlug(cwd)}${prefix}`;
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith(start) && n.endsWith(".json"))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** The pid of the Claude Code process this one runs under; Claude Code passes it to its commands and hooks. */
export function claudePidFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const pid = Number(env.CLAUDE_PID);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Whether the viewer was open when Claude Code last exited in this project. */
export function restoreFile(cwd: string): string {
  return stateFile(cwd, ".restore");
}

/** Where each list was left: selection and scroll positions (`src/positions.ts`). */
export function positionsFile(cwd: string): string {
  return stateFile(cwd, ".positions");
}

/** The view each session of the project was shown in last. */
export function sessionViewsFile(cwd: string): string {
  return stateFile(cwd, ".views");
}

/** Marked (favourite) turns per session. */
export function favoritesFile(cwd: string): string {
  return stateFile(cwd, ".favorites");
}

export function readActive(cwd: string): ActiveSession | undefined {
  return readJson<ActiveSession>(activeFile(cwd));
}

export function writeActive(session: ActiveSession): void {
  writeJson(activeFile(session.cwd), session);
}
