import { rmSync } from "node:fs";
import { basename } from "node:path";
import { openPane } from "./open.js";
import { readSessionView } from "./sessionViews.js";
import { readSettings } from "./settings.js";
import {
  claudeFile,
  claudePidFromEnv,
  projectStateFiles,
  readActive,
  readJson,
  writeActive,
  writeJson,
  type ActiveSession,
} from "./transcript/locate.js";
import { anyRunningViewer, isAlive, readRestore, runningViewer, saveRestore } from "./viewer.js";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  /** SessionEnd only: why the session ended ("clear", "logout", "prompt_input_exit", …). */
  reason?: string;
  /** SessionStart only: "startup", "resume", "clear" or "compact". */
  source?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Removes per-process state files of Claude Code processes and viewers that are gone. */
function removeStaleFiles(cwd: string): void {
  for (const prefix of [".claude-", ".viewer-", ".control-"]) {
    for (const file of projectStateFiles(cwd, prefix)) {
      const pid = Number(basename(file, ".json").split(prefix).at(-1));
      if (Number.isInteger(pid) && pid > 0 && !isAlive(pid)) rmSync(file, { force: true });
    }
  }
}

/**
 * Records which session is active, per Claude Code process (`claudePid`) and
 * for the project, so a running viewer can follow it, and marks it ended when
 * Claude Code exits so the viewer closes itself. Whether the viewer was open
 * at exit is remembered and restored on the next start.
 */
export function handleHook(input: HookInput, open = openPane, claudePid = claudePidFromEnv()): void {
  if (!input.session_id || !input.transcript_path || !input.cwd) return;
  const cwd = input.cwd;
  const updated = new Date().toISOString();

  if (input.hook_event_name === "SessionEnd") {
    // /clear ends the session but a new one starts right away in the same terminal.
    if (input.reason === "clear") return;
    const active = readActive(cwd);
    const ownActive = active?.session_id === input.session_id;
    const own = claudePid ? readJson<ActiveSession>(claudeFile(cwd, claudePid)) : undefined;
    // Without the process known, the project's active session is the only state; another session may own it.
    if (claudePid !== undefined || ownActive) {
      // Checked before marking the session ended: the viewer closes itself afterwards.
      const viewer = runningViewer(cwd, claudePid);
      // A session without a viewer of its own leaves the remembered state alone while another session's viewer runs.
      if (viewer || !anyRunningViewer(cwd)) saveRestore(cwd, { open: viewer !== undefined, view: viewer?.view ?? "chat" });
    }
    if (claudePid && own?.session_id === input.session_id) writeJson(claudeFile(cwd, claudePid), { ...own, ended: true, updated });
    if (ownActive) writeActive({ ...active, ended: true, updated });
    return;
  }

  const session: ActiveSession = { session_id: input.session_id, transcript_path: input.transcript_path, cwd, updated };
  writeActive(session);
  if (claudePid) writeJson(claudeFile(cwd, claudePid), session);

  // A fresh Claude Code process (not /clear or compaction): open the viewer as the autoOpen setting says.
  if (input.hook_event_name === "SessionStart" && (input.source === "startup" || input.source === "resume")) {
    removeStaleFiles(cwd);
    const restore = readRestore(cwd);
    const { autoOpen, rememberView } = readSettings();
    // "remember": only if it was open at exit; "always": also in projects it never ran in, with the chat.
    const wanted = autoOpen === "always" || (autoOpen === "remember" && restore?.open === true);
    // Only when no viewer runs in the project, e.g. not for a session started from the Sessions view next to one.
    // The session's own last view (after --resume) wins over the project's.
    const view = (rememberView ? readSessionView(cwd, input.session_id) : undefined) ?? restore?.view ?? "chat";
    if (wanted && !anyRunningViewer(cwd)) open(cwd, view, { keepFocus: true, claudePid });
  }
}

/** Claude Code hook entry point. Never fails the hook; prints nothing, since SessionStart output reaches Claude. */
export async function runHook(): Promise<void> {
  try {
    handleHook(JSON.parse(await readStdin()) as HookInput);
  } catch (err) {
    process.stderr.write(`cco hook: ${(err as Error).message}\n`);
  }
}
