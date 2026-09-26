import { openPane } from "./open.js";
import { readActive, writeActive } from "./transcript/locate.js";
import { readRestore, runningViewer, saveRestore } from "./viewer.js";

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

/**
 * Records which session is active in a project so a running viewer can follow
 * it, and marks it ended when Claude Code exits so the viewer closes itself.
 * Whether the viewer was open at exit is remembered and restored on the next start.
 */
export function handleHook(input: HookInput, open = openPane): void {
  if (!input.session_id || !input.transcript_path || !input.cwd) return;
  const cwd = input.cwd;
  const updated = new Date().toISOString();

  if (input.hook_event_name === "SessionEnd") {
    // /clear ends the session but a new one starts right away in the same terminal.
    if (input.reason === "clear") return;
    const active = readActive(cwd);
    // Another session of the project may have taken over; leave its state alone.
    if (active?.session_id !== input.session_id) return;
    // Checked before marking the session ended: the viewer closes itself afterwards.
    const viewer = runningViewer(cwd);
    saveRestore(cwd, { open: viewer !== undefined, view: viewer?.view ?? "chat" });
    writeActive({ ...active, ended: true, updated });
    return;
  }

  writeActive({ session_id: input.session_id, transcript_path: input.transcript_path, cwd, updated });

  // A fresh Claude Code process (not /clear or compaction): reopen the viewer if it was open at exit.
  if (input.hook_event_name === "SessionStart" && (input.source === "startup" || input.source === "resume")) {
    const restore = readRestore(cwd);
    if (restore?.open && runningViewer(cwd) === undefined) open(cwd, restore.view, { keepFocus: true });
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
