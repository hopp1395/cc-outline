import { writeActive } from "./transcript/locate.js";

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Claude Code hook entry point: records the session that is currently active in a
 * project so a running viewer can switch to it. Never fails the hook.
 */
export async function runHook(): Promise<void> {
  try {
    const input = JSON.parse(await readStdin()) as HookInput;
    if (!input.session_id || !input.transcript_path || !input.cwd) return;
    writeActive({
      session_id: input.session_id,
      transcript_path: input.transcript_path,
      cwd: input.cwd,
      updated: new Date().toISOString(),
    });
  } catch (err) {
    process.stderr.write(`ccmd hook: ${(err as Error).message}\n`);
  }
}
