import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cliFile } from "./cliPath.js";
import { proc } from "./proc.js";
import { TIMING } from "./timing.js";
import { runningSessions } from "./transcript/trash.js";
import { claudeDir, claudePidFromEnv, projectSlug, readJson, writeJson } from "./transcript/locate.js";
import { isAlive, requestEdit, runningViewer } from "./viewer.js";

/**
 * Ctrl+G in Claude Code runs `$VISUAL <file>` (else `$EDITOR`, on Windows else Notepad) through the shell, waits
 * until it exits and takes the file back into its prompt line. With VISUAL set to `cco edit` (Settings: Reset,
 * prompt editor), that opens cco's prompt editor: in the viewer of that Claude Code if it can take the keyboard
 * focus (docked in Windows Terminal, tmux), else in Claude Code's own pane.
 */

/** How the viewer answers `cco edit`, in the reply file next to the edited one. */
export type EditState = "open" | "declined" | "done" | "cancelled";

export const replyFile = (file: string) => `${file}.cco.json`;

export function writeReply(file: string, state: EditState): void {
  try {
    writeFileSync(replyFile(file), JSON.stringify({ state, at: Date.now() }));
  } catch {
    // The file's folder is gone: cco edit has ended.
  }
}

export function readReply(file: string): EditState | undefined {
  try {
    return (JSON.parse(readFileSync(replyFile(file), "utf8")) as { state?: EditState }).state;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sameDir = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** Every process's parent, from one PowerShell call (Windows) or `ps` (elsewhere); empty if neither works. */
async function parents(): Promise<Map<number, number>> {
  const [cmd, args] =
    process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"]]
      : ["ps", ["-A", "-o", "pid=,ppid="]];
  const out = await new Promise<string | undefined>((done) =>
    proc.execFile(cmd, args as string[], { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => done(err ? undefined : String(stdout))),
  );
  const map = new Map<number, number>();
  for (const line of (out ?? "").split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) map.set(pid, ppid);
  }
  return map;
}

/**
 * The Claude Code process that started `cco edit`: CLAUDE_PID if Claude Code passed it, else the one running in
 * `cwd` if it is the only one there, else the nearest ancestor of this process that is a running Claude Code.
 */
export async function findClaudePid(cwd: string): Promise<{ pid: number; sessionId: string } | undefined> {
  const running = [...runningSessions()].map(([sessionId, s]) => ({ sessionId, ...s }));
  const fromEnv = claudePidFromEnv();
  const byPid = (pid: number | undefined) => running.find((s) => s.pid === pid);
  if (fromEnv && byPid(fromEnv)) return { pid: fromEnv, sessionId: byPid(fromEnv)!.sessionId };
  const here = running.filter((s) => s.cwd && sameDir(s.cwd, cwd));
  if (here.length === 1) return { pid: here[0]!.pid, sessionId: here[0]!.sessionId };
  const map = await parents();
  for (let pid: number | undefined = process.ppid, i = 0; pid && i < 8; pid = map.get(pid), i++) {
    const s = byPid(pid);
    if (s) return { pid, sessionId: s.sessionId };
  }
  return undefined;
}

/**
 * Hands the file to the viewer of `claudePid` and waits until it is done with it. `declined` when the viewer did
 * not take it (it cannot take the focus, or did not answer in time) or quit before it was done.
 */
export async function editInViewer(cwd: string, claudePid: number, viewerPid: number, file: string, say: (text: string) => void): Promise<EditState> {
  rmSync(replyFile(file), { force: true });
  requestEdit(cwd, claudePid, { file, pid: process.pid });
  try {
    for (const until = Date.now() + TIMING.editAnswer; ; await sleep(TIMING.editPoll)) {
      const state = readReply(file);
      if (state === "open") break;
      if (state === "declined" || Date.now() > until || !isAlive(viewerPid)) return "declined";
    }
    say("Editing the prompt in the cco viewer: Ctrl+Enter or Ctrl+S hands it over, Esc there closes it.");
    for (;;) {
      await sleep(TIMING.editPoll);
      const state = readReply(file);
      if (state === "done" || state === "cancelled") return state;
      if (!isAlive(viewerPid)) return "declined";
    }
  } finally {
    rmSync(replyFile(file), { force: true });
  }
}

/** `cco edit <file>`: what Claude Code's Ctrl+G runs with VISUAL set up. Exits when the prompt is handed over or closed. */
export async function runEdit(file: string, loadEditor: () => Promise<typeof import("./editor.js")>, cwd = process.cwd()): Promise<number> {
  if (!existsSync(file)) {
    console.error(`cco: ${file} does not exist`);
    return 1;
  }
  const claude = await findClaudePid(cwd);
  const viewer = claude && runningViewer(cwd, claude.pid);
  if (claude && viewer) {
    const state = await editInViewer(cwd, claude.pid, viewer.pid, file, (text) => process.stdout.write(`${text}\n`));
    if (state !== "declined") return 0;
  }
  const { runPromptEditor } = await loadEditor();
  await runPromptEditor({ file, draftKey: claude?.sessionId ?? `project-${projectSlug(cwd)}`, cwd });
  return 0;
}

// ---------------------------------------------------------------- Setup (VISUAL in Claude Code's settings.json)

/** Claude Code's settings of this config folder, whose `env` it applies to its own process. */
export const claudeSettingsFile = () => join(claudeDir(), "settings.json");
/** What VISUAL was before cco set it up, to put back when it is removed. */
const editorStateFile = () => join(claudeDir(), "cco", "editor.json");

/** The command VISUAL is set to: node and this CLI, quoted, so Claude Code's shell finds both. */
export function editorCommand(cli = readJson<{ cli?: string }>(cliFile())?.cli ?? process.argv[1] ?? ""): string {
  return `"${process.execPath}" "${cli}" edit`;
}

/** Whether a VISUAL value runs `cco edit`. */
export const isCcoEditor = (value: unknown): value is string => typeof value === "string" && /cli\.js"?\s+edit\s*$/.test(value);

export interface EditorSetup {
  /** VISUAL in Claude Code's settings.json, if set. */
  visual?: string;
  /** It runs cco edit. */
  cco: boolean;
  /** It runs a cco edit whose CLI is gone (moved or uninstalled). */
  stale: boolean;
  /** settings.json is no JSON object: cco does not change it. */
  unreadable: boolean;
}

function readClaudeSettings(): Record<string, unknown> | null | undefined {
  let text: string;
  try {
    text = readFileSync(claudeSettingsFile(), "utf8");
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readEditorSetup(): EditorSetup {
  const settings = readClaudeSettings();
  const env = settings?.env as Record<string, unknown> | undefined;
  const visual = typeof env?.VISUAL === "string" ? env.VISUAL : undefined;
  const cco = isCcoEditor(visual);
  const cli = cco ? /"([^"]*cli\.js)"/.exec(visual!)?.[1] : undefined;
  return { visual, cco, stale: cco && (!cli || !existsSync(cli)), unreadable: settings === null };
}

/** Writes Claude Code's settings.json with `change` applied to its env; a backup of the file before goes next to it. */
function changeEnv(change: (env: Record<string, unknown>) => void): void {
  const settings = readClaudeSettings();
  if (settings === null) throw new Error("settings.json is no valid JSON: cco leaves it alone");
  const next = { ...(settings ?? {}) };
  const env = { ...((typeof next.env === "object" && next.env !== null ? next.env : {}) as Record<string, unknown>) };
  change(env);
  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  const file = claudeSettingsFile();
  if (existsSync(file)) writeFileSync(`${file}.cco-backup`, readFileSync(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Sets VISUAL to `cco edit`, keeping what it was before (not cco's) for `removeEditor`. */
export function setUpEditor(command = editorCommand()): void {
  const { visual } = readEditorSetup();
  if (visual !== undefined && !isCcoEditor(visual)) writeJson(editorStateFile(), { previous: visual });
  changeEnv((env) => {
    env.VISUAL = command;
  });
}

/** Puts VISUAL back to what it was before cco set it up, or removes it. */
export function removeEditor(): void {
  const previous = readJson<{ previous?: string }>(editorStateFile())?.previous;
  changeEnv((env) => {
    if (typeof previous === "string") env.VISUAL = previous;
    else delete env.VISUAL;
  });
  rmSync(editorStateFile(), { force: true });
}
