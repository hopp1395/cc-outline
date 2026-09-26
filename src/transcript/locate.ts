import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ActiveSession {
  session_id: string;
  transcript_path: string;
  cwd: string;
  updated: string;
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

/** Most recently modified transcript of the project, if any. */
export function findLatestTranscript(cwd: string): string | undefined {
  const dir = projectDir(cwd);
  let best: { path: string; mtime: number } | undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path;
}

export function transcriptForSession(cwd: string, sessionId: string): string {
  return join(projectDir(cwd), `${sessionId}.jsonl`);
}

/** State written by the hook: one file per project so parallel sessions don't clash. */
export function activeFile(cwd: string): string {
  return join(claudeDir(), "ccmd", `${projectSlug(cwd)}.json`);
}

export function readActive(cwd: string): ActiveSession | undefined {
  try {
    return JSON.parse(readFileSync(activeFile(cwd), "utf8")) as ActiveSession;
  } catch {
    return undefined;
  }
}

export function writeActive(session: ActiveSession): void {
  const file = activeFile(session.cwd);
  mkdirSync(join(claudeDir(), "ccmd"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(session, null, 2));
  renameSync(tmp, file);
}
