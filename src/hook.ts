import { readActive, writeActive } from "./transcript/locate.js";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  /** SessionEnd only: why the session ended ("clear", "logout", "prompt_input_exit", …). */
  reason?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Records which session is active in a project so a running viewer can follow
 * it, and marks it ended when Claude Code exits so the viewer closes itself.
 */
export function handleHook(input: HookInput): void {
  if (!input.session_id || !input.transcript_path || !input.cwd) return;
  const updated = new Date().toISOString();

  if (input.hook_event_name === "SessionEnd") {
    // /clear ends the session but a new one starts right away in the same terminal.
    if (input.reason === "clear") return;
    const active = readActive(input.cwd);
    // Another session of the project may have taken over; leave its state alone.
    if (active?.session_id !== input.session_id) return;
    writeActive({ ...active, ended: true, updated });
    return;
  }

  writeActive({
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    updated,
  });
}

/** Claude Code hook entry point. Never fails the hook. */
export async function runHook(): Promise<void> {
  try {
    handleHook(JSON.parse(await readStdin()) as HookInput);
  } catch (err) {
    process.stderr.write(`cce hook: ${(err as Error).message}\n`);
  }
}
