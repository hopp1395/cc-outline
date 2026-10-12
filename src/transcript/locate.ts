import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

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

/** Whether `dir` is Claude Code's default config folder, `~/.claude`, which is used without CLAUDE_CONFIG_DIR. */
export function isDefaultClaudeDir(dir: string, home = homedir()): boolean {
  const a = resolve(dir);
  const b = resolve(join(home, ".claude"));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * `env` for a process that runs under the config folder `dir`: CLAUDE_CONFIG_DIR set to it, or removed for the
 * default folder, whose account Claude Code also reads from `~/.claude.json`.
 */
export function withClaudeDir(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const result = { ...env };
  // Windows environment names are case-insensitive, and Node keeps the original spelling.
  for (const key of Object.keys(result)) if (key.toUpperCase() === "CLAUDE_CONFIG_DIR") delete result[key];
  if (!isDefaultClaudeDir(dir)) result.CLAUDE_CONFIG_DIR = dir;
  return result;
}

/** Makes this process run under the config folder `dir` from now on, as `withClaudeDir` gives it to a child. */
export function setClaudeDir(dir: string): void {
  for (const key of Object.keys(process.env)) if (key.toUpperCase() === "CLAUDE_CONFIG_DIR") delete process.env[key];
  if (!isDefaultClaudeDir(dir)) process.env.CLAUDE_CONFIG_DIR = dir;
}

/**
 * Runs `fn` as if this process ran under the config folder `dir` (another account's): every path through
 * `claudeDir()` (transcripts, `sessions/`, cco's state files) is that folder's while it runs. Synchronous
 * code only, so nothing else runs meanwhile.
 */
export function inClaudeDir<T>(dir: string, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, "CLAUDE_CONFIG_DIR");
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (had) process.env.CLAUDE_CONFIG_DIR = before;
    else delete process.env.CLAUDE_CONFIG_DIR;
  }
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

/**
 * The session of process `claudePid` went on from `from` in `transcript` (`continued-in`):
 * records that one as its session, so a viewer opened later follows it and the
 * old session's end does not close the viewer. Its hooks run in another
 * process (the Claude Code daemon's), which writes a state file of its own.
 */
export function continueSession(cwd: string, claudePid: number, from: string, transcript: string): void {
  const file = claudeFile(cwd, claudePid);
  const own = readJson<ActiveSession>(file);
  // Only while the process's session is still the one continued: after /resume or /clear it is another.
  if (!own || own.transcript_path !== from) return;
  const session_id = basename(transcript, ".jsonl");
  writeJson(file, { session_id, transcript_path: transcript, cwd: own.cwd, updated: new Date().toISOString() } satisfies ActiveSession);
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

/**
 * A viewer waiting to pair with the Claude Code it started for a session (Sessions): that Claude Code's
 * SessionStart hook opens no viewer of its own, since this one moves next to it.
 */
export function pairingFile(cwd: string): string {
  return stateFile(cwd, ".pairing");
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

/** Sessions continued in another account, or from one (`src/transfers.ts`). */
export function transfersFile(cwd: string): string {
  return stateFile(cwd, ".accounts");
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
