import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readJson } from "./locate.js";
import type { AgentRun } from "./parse.js";

/** Where Claude Code keeps the transcripts of a session's subagents: `<session-id>/subagents/` next to its transcript. */
export function subagentDir(transcript: string): string {
  return join(dirname(transcript), basename(transcript, ".jsonl"), "subagents");
}

/**
 * The transcript of `agent`, `agent-<agentId>.jsonl`. The agentId is known
 * once the Agent call returned; before that (a foreground agent still
 * working), the `.meta.json` next to each transcript names the tool call.
 */
export function subagentFile(transcript: string, agent: AgentRun): string | undefined {
  const dir = subagentDir(transcript);
  if (agent.agentId) {
    const file = join(dir, `agent-${agent.agentId}.jsonl`);
    if (existsSync(file)) return file;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    if (readJson<{ toolUseId?: string }>(join(dir, name))?.toolUseId !== agent.id) continue;
    const file = join(dir, name.replace(/\.meta\.json$/, ".jsonl"));
    if (existsSync(file)) return file;
  }
  return undefined;
}
