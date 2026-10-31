import { rmSync } from "node:fs";
import { basename } from "node:path";
import { clearLocalRequest, recordLocalRequest, removeOldLocalRequests } from "./localRequest.js";
import { removeStaleSessionViewers } from "./sessionViewers.js";
import { cleanupPromptFiles } from "./promptDraft.js";
import { openPane } from "./open.js";
import { readSessionView, resolvePlacement } from "./sessionViews.js";
import { readSettings, shownView } from "./settings.js";
import { repairStatusLine, syncStatusLineSetting } from "./statusline/setup.js";
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
import { anyRunningViewer, isAlive, readRestore, runningViewer, saveRestore, takePairing } from "./viewer.js";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  /** SessionEnd only: why the session ended ("clear", "logout", "prompt_input_exit", …). */
  reason?: string;
  /** SessionStart only: "startup", "resume", "clear" or "compact". */
  source?: string;
  /** PreToolUse and PermissionRequest: the tool and its input. */
  tool_name?: string;
  tool_input?: unknown;
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
  // Session viewers belong to no project: those of every account register below the default folder.
  removeStaleSessionViewers();
  // The prompt editor's images and drafts after 30 days.
  cleanupPromptFiles();
}

/**
 * cco's status line points at the installed cco (after a reinstall elsewhere), and the setting follows a change of
 * `statusLine` by hand. A status line of the user's own is never touched.
 */
function keepStatusLine(): void {
  try {
    repairStatusLine();
    syncStatusLineSetting();
  } catch {
    // An unreadable settings.json: the doctor reports it.
  }
}

/**
 * Records which session is active, per Claude Code process (`claudePid`) and
 * for the project, so a running viewer can follow it, and marks it ended when
 * Claude Code exits so the viewer closes itself. Whether the viewer was open
 * at exit is remembered and restored on the next start.
 */
export function handleHook(input: HookInput, open = openPane, claudePid = claudePidFromEnv()): void {
  // What Claude asks (AskUserQuestion) or wants allowed: recorded for the Remote Control Viewer to show, and nothing
  // more; with no output the hook decides nothing, so Claude Code asks in its terminal as always.
  if (input.hook_event_name === "PreToolUse" || input.hook_event_name === "PermissionRequest") return recordLocalRequest(input);
  if (!input.session_id || !input.transcript_path || !input.cwd) return;
  // A prompt was typed, or the session ends: what it asked before is answered.
  if (input.hook_event_name === "UserPromptSubmit" || input.hook_event_name === "SessionEnd") clearLocalRequest(input.session_id);
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
  // The hook runs in Claude Code's pane: the pane is the process's, not the project's.
  if (claudePid) writeJson(claudeFile(cwd, claudePid), { ...session, wezterm_pane: process.env.WEZTERM_PANE || undefined });

  // A fresh Claude Code process (not /clear or compaction): open the viewer as the autoOpen setting says.
  if (input.hook_event_name === "SessionStart" && (input.source === "startup" || input.source === "resume")) {
    removeStaleFiles(cwd);
    removeOldLocalRequests();
    keepStatusLine();
    const restore = readRestore(cwd);
    const settings = readSettings();
    const { autoOpen, rememberView } = settings;
    // "remember": only if it was open at exit; "always": also in projects it never ran in, with the chat.
    const wanted = autoOpen === "always" || (autoOpen === "remember" && restore?.open === true);
    // Only when this process has no viewer yet. A session started from the Sessions view runs in a window of
    // its own and gets its own viewer there, next to the one in the project's other window. Without the
    // process known, only when none runs in the project (openPane would reuse it).
    // The session's own last view (after --resume) wins over the project's.
    // A view hidden in the settings is not reopened; the first shown one opens instead.
    const view = shownView(settings, (rememberView ? readSessionView(cwd, input.session_id) : undefined) ?? restore?.view ?? "chat");
    // The placement chosen for this session with p, else the setting.
    const placement = resolvePlacement(cwd, input.session_id);
    const running = claudePid ? runningViewer(cwd, claudePid) !== undefined : anyRunningViewer(cwd);
    // A viewer started this Claude Code from its Sessions view and moves next to it once it runs.
    const paired = takePairing(cwd, input.session_id);
    if (wanted && !running && !paired) open(cwd, view, { keepFocus: true, claudePid, placement });
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
