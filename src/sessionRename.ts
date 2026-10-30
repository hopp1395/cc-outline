import { confirmed, sendRename, setTitle } from "./remote/api.js";
import { describeRemoteError } from "./remote/index.js";
import { commandSteps, keysInClaude } from "./switchSession.js";
import { TIMING } from "./timing.js";
import { renameSession } from "./transcript/rename.js";
import type { RunningSession } from "./transcript/trash.js";
import { localBlocked } from "./tui/useLocalPrompt.js";

/** Where a session stands for renaming it (Sessions, the Remote Control Viewer). */
export interface RenameSituation {
  /** A session of this machine: the transcript it continues in (the last of its chain) and its id. Missing for a remote one. */
  local?: { path: string; id: string };
  /** The Claude Code that runs it on this machine. */
  running?: RunningSession;
  /** Its session on claude.ai: a remote one's own, or the twin of one of this machine (⇄); `connected` while its Claude Code is. */
  remote?: { id: string; connected: boolean };
  /** Setting remoteControl (steer remote): cco may write to claude.ai. */
  control: boolean;
  /** The config folder of the account it belongs to; none for the viewer's own. */
  dir?: string;
}

/**
 * How a session is renamed: `claude.ai` sets its title there and, while its Claude Code is connected, tells that
 * one too (`rename_session`); `keys` types /rename into the Claude Code that runs it here; `transcript` appends a
 * `custom-title` to a session that runs nowhere (and sets the title on claude.ai too where it has one there).
 */
export type RenameWay = "claude.ai" | "keys" | "transcript";

/** The rename option of a session: how, what the dialog says about it, or why it cannot be chosen. */
export interface RenamePlan {
  way?: RenameWay;
  detail: string;
  disabled?: string;
}

const OFF = "steer remote is off (Settings of a viewer)";

/** How `s` can be renamed so that its name is the same everywhere: through claude.ai where it can, else here. */
export function renamePlan(s: RenameSituation): RenamePlan {
  const { remote, running, control } = s;
  if (remote?.connected && control) return { way: "claude.ai", detail: "on claude.ai and in the Claude Code that runs it" };
  if (running) {
    const blocked = localBlocked(running) ?? (running.activity === "busy" ? "Claude is working: rename it once it is idle" : undefined);
    return { way: blocked ? undefined : "keys", detail: "types /rename into its Claude Code", disabled: blocked };
  }
  if (s.local) {
    if (!remote) return { way: "transcript", detail: "a new title, as /rename gives it" };
    return { way: "transcript", detail: control ? "a new title, here and on claude.ai" : "a new title here; steer remote is off, so claude.ai keeps its own" };
  }
  if (!remote) return { detail: "", disabled: "it is nowhere to be renamed" };
  if (!control) return { detail: "on claude.ai", disabled: OFF };
  return { way: "claude.ai", detail: "on claude.ai; its machine is not connected and keeps its name" };
}

/** What renaming does outside cco's own code, swapped by tests. */
export const renameIo = {
  setTitle,
  sendRename,
  confirmed,
  type: (pid: number, text: string) => keysInClaude(pid, commandSteps(text)),
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** Renames `s` as `renamePlan` says; resolves to what the top bar reports, rejects with a readable error. */
export async function renameAnywhere(s: RenameSituation, title: string): Promise<string> {
  const plan = renamePlan(s);
  if (!plan.way) throw new Error(plan.disabled ?? "it cannot be renamed");
  const remote = (p: Promise<unknown>) => p.catch((err) => Promise.reject(new Error(describeRemoteError(err))));
  switch (plan.way) {
    case "keys": {
      const result = await renameIo.type(s.running!.pid, `/rename ${title}`);
      if (!result.typed) throw new Error(result.message);
      return `typed /rename ${title}`;
    }
    case "transcript": {
      renameSession(s.local!.path, s.local!.id, title);
      if (!s.remote || !s.control) return `renamed: ${title}`;
      try {
        await remote(renameIo.setTitle(s.remote.id, title, s.dir));
      } catch (err) {
        return `renamed here: ${title}; claude.ai kept its title (${(err as Error).message})`;
      }
      return `renamed: ${title}`;
    }
    case "claude.ai": {
      const { id, connected } = s.remote!;
      await remote(renameIo.setTitle(id, title, s.dir));
      if (!connected) return `renamed on claude.ai: ${title}; its machine keeps its name`;
      const requestId = (await remote(renameIo.sendRename(id, title, s.dir))) as string;
      return (await answered(id, requestId, s.dir)) ? `renamed: ${title}` : `renamed on claude.ai: ${title}; its Claude Code did not confirm`;
    }
  }
}

/** Whether the Claude Code of session `id` confirms the request `requestId` within `TIMING.renameConfirm`. */
async function answered(id: string, requestId: string, dir?: string): Promise<boolean> {
  const until = Date.now() + TIMING.renameConfirm;
  do {
    await renameIo.wait(Math.min(TIMING.remotePoll, TIMING.renameConfirm));
    if (await renameIo.confirmed(id, requestId, dir).catch(() => false)) return true;
  } while (Date.now() < until);
  return false;
}
