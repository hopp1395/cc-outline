import { BUILTIN_COMMANDS } from "../builtinCommands.js";
import type { SlashCommand } from "../slashCommands.js";
import { listEvents, sendInitialize, type RemoteEvent } from "./api.js";

/** How long after `initialize` the `init` event is waited for, and how often the events are read meanwhile. */
const INIT_WAIT_MS = 6000;
const INIT_POLL_MS = 1000;

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/**
 * The `/` commands of a remote session as its newest `system` `init` event lists them (`slash_commands`, names only),
 * without the ones the app hides on a phone (`terminal_slash_commands`); Claude Code's own get their description from
 * `BUILTIN_COMMANDS`. Undefined while no event lists them (a worker before 2.1.310 wrote `init` with its session id only).
 */
export function initCommands(events: RemoteEvent[]): SlashCommand[] | undefined {
  const init = [...events].reverse().find((e) => e.payload.type === "system" && e.payload.subtype === "init" && Array.isArray(e.payload.slash_commands));
  if (!init) return undefined;
  const hidden = new Set(strings(init.payload.terminal_slash_commands));
  const known = new Map(BUILTIN_COMMANDS.map((c) => [c.name, c]));
  return strings(init.payload.slash_commands)
    .filter((name) => !hidden.has(name))
    .map((name) => known.get(name) ?? { name, description: "" });
}

/**
 * The `/` commands of remote session `id`: from the `init` among its newest events, else asked for with an
 * `initialize` (as the app does when it opens it) and read from the `init` the worker writes then.
 */
export async function remoteCommands(id: string, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<SlashCommand[]> {
  const listed = initCommands((await listEvents(id)).events);
  if (listed) return listed;
  await sendInitialize(id);
  for (let waited = 0; waited < INIT_WAIT_MS; waited += INIT_POLL_MS) {
    await wait(INIT_POLL_MS);
    const commands = initCommands((await listEvents(id)).events);
    if (commands) return commands;
  }
  return [];
}
