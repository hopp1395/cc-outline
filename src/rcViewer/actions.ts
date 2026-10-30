import type { PendingRequest } from "../remote/pending.js";
import type { RenamePlan } from "../sessionRename.js";
import type { RunningSession } from "../transcript/trash.js";
import { viewerOptions, type ChoiceOption } from "../tui/resumeChoice.js";
import { answerable } from "../tui/useRemoteControl.js";
import { questionsOf } from "../tui/QuestionDialog.js";
import type { RcViewerState } from "./state.js";

/**
 * What Enter in the Remote Control Viewer can do with the selected session:
 * - `switch`: bring the terminal its Claude Code runs in to the front (a local session).
 * - `answer`: answer what a remote session's Claude waits for, in the prompt line's place.
 * - `prompt`: write a prompt in the line below the chat.
 * - `interrupt`: stop Claude, like Esc in its terminal.
 * - `steer`: make an idle session of this machine steerable here: `/remote-control` typed into its Claude Code.
 * - `window`: continue an ended session of this machine in a new Claude Code window.
 * - `viewer`/`viewer-front`: a session viewer of it, as in Sessions.
 * - `rename`: give it a new name, the same here, in its Claude Code and on claude.ai (`renamePlan`).
 * - `copy`: copy the command that continues it, or a remote one's address.
 */
export type RcViewerAction = "switch" | "answer" | "prompt" | "interrupt" | "steer" | "window" | "viewer" | "viewer-front" | "rename" | "copy";

/** Where the selected session stands, as far as the Remote Control Viewer's Enter dialog cares. */
export interface RcViewerSituation {
  state: RcViewerState;
  /** A remote session: whether cco may send to it (setting remoteControl), and what it waits for. */
  remote?: { control: boolean; pending?: PendingRequest };
  /** One of this machine's sessions: the Claude Code it runs in. */
  running?: RunningSession;
  /**
   * One of this machine's sessions connected to claude.ai (Remote Control, ⇄): whether cco may send to it there
   * (setting steer remote), and what it waits for, read from there.
   */
  bridge?: { control: boolean; pending?: PendingRequest };
  /**
   * An idle session of this machine not connected to claude.ai, with remote API and steer remote on: it can be made
   * steerable here by typing `/remote-control` into it.
   */
  canSteer?: boolean;
  /** What a waiting session of this machine asks, as its hooks recorded it, in one line. */
  asked?: string;
  /** Why a prompt cannot be typed into its Claude Code (`localBlocked`); undefined when it can. */
  promptBlocked?: string;
  /** Its folder is gone: it cannot continue. */
  folderMissing?: boolean;
  /** Windows Terminal, WezTerm or tmux runs the Remote Control Viewer: tabs can be switched and windows opened. */
  terminal: boolean;
  /** How many session viewers of it run. */
  viewers: number;
  /** The command `copy` copies (or the address of a remote session). */
  command: string;
  /** How it can be renamed (`renamePlan`). */
  rename: RenamePlan;
}

const NO_TERMINAL = "no Windows Terminal, WezTerm or tmux";

/** Why `switch` cannot bring a local session's terminal to the front. */
function switchBlocked(s: RcViewerSituation): string | undefined {
  if (!s.terminal) return NO_TERMINAL;
  const run = s.running;
  if (run?.kind === "bg") return run.jobId ? `a background session has no tab: claude attach ${run.jobId}` : "a background session has no tab";
  return undefined;
}

/**
 * The options Enter offers in the Remote Control Viewer for a session, and the one selected at first. A waiting session: a local one's
 * terminal (its question or permission is answered there), a remote one's answer; a working one: its terminal, so a
 * slip of Enter stops nothing; an idle one: a prompt; an ended one: continuing it in a new window.
 */
export function rcViewerOptions(s: RcViewerSituation): { options: ChoiceOption<RcViewerAction>[]; initial: number } {
  const options: ChoiceOption<RcViewerAction>[] = [];
  const working = s.state === "busy";
  let preferred: RcViewerAction[];
  if (s.remote) {
    const off = s.remote.control ? undefined : "steer remote is off (Settings of a viewer)";
    if (s.state === "waiting") options.push(answerOption(s.remote.pending, off));
    if (s.state !== "ended") {
      options.push({ id: "prompt", label: "Write a prompt", detail: s.state === "waiting" ? "Claude takes it in once answered" : working ? "Claude takes it in when it can" : "in the line below the chat", disabled: off });
      if (working || s.state === "waiting") options.push({ id: "interrupt", label: "Interrupt Claude", detail: "stops what Claude does, like Esc in the terminal", disabled: off });
    }
    preferred = s.state === "waiting" ? ["answer", "viewer"] : ["prompt", "viewer"];
    options.push(...viewerOptions(s.viewers, s.terminal, { control: s.remote.control }));
    options.push(renameOption(s.rename));
    options.push({ id: "copy", label: "Copy its address", detail: s.command });
    return { options, initial: firstOf(options, preferred) };
  }
  if (s.state === "ended") {
    options.push({ id: "window", label: "Continue it in a new Claude Code window", detail: "claude --resume", disabled: s.folderMissing ? "its folder is gone" : s.terminal ? undefined : NO_TERMINAL });
    preferred = ["window", "viewer"];
  } else {
    // Connected to claude.ai with steer remote on: what it waits for is answered here, prompts go there.
    const through = s.bridge?.control ? "through claude.ai" : undefined;
    const answers = s.state === "waiting" && s.bridge !== undefined;
    if (answers) options.push(answerOption(s.bridge!.pending, s.bridge!.control ? undefined : "steer remote is off (Settings of a viewer)"));
    options.push({
      id: "switch",
      label: "Bring its terminal to the front",
      detail: s.state === "waiting" ? (answers ? "or answer it there" : (s.asked ?? "Claude waits there for your answer")) : "the tab or pane its Claude Code runs in",
      disabled: switchBlocked(s),
    });
    options.push({
      id: "prompt",
      label: "Write a prompt",
      detail: through ? `in the line below the chat, ${through}` : working ? "typed in once you send it; Claude takes it in when it can" : "in the line below the chat, typed into its Claude Code",
      disabled: s.promptBlocked,
    });
    if (working) options.push({ id: "interrupt", label: "Interrupt Claude", detail: through ? `stops what Claude does, ${through}` : "Esc, typed into its Claude Code", disabled: s.promptBlocked });
    if (s.canSteer && s.state === "idle")
      options.push({
        id: "steer",
        label: "Make it steerable (Remote Control)",
        detail: "types /remote-control into its Claude Code; the first time, it asks once there",
        disabled: s.promptBlocked,
      });
    preferred = s.state === "idle" ? ["prompt", "switch"] : answers ? ["answer", "switch"] : ["switch", "prompt"];
  }
  options.push(...viewerOptions(s.viewers, s.terminal));
  options.push(renameOption(s.rename));
  options.push({ id: "copy", label: "Copy the command", detail: s.command });
  return { options, initial: firstOf(options, [...preferred, "viewer"]) };
}

const renameOption = (plan: RenamePlan): ChoiceOption<RcViewerAction> => ({ id: "rename", label: "Rename it", detail: plan.detail, disabled: plan.disabled });

/** The answer option of a remote session that waits: what it waits for, if known and in a shape cco can answer. */
function answerOption(pending: PendingRequest | undefined, off: string | undefined): ChoiceOption<RcViewerAction> {
  if (!pending) return { id: "answer", label: "Answer it", detail: "", disabled: off ?? "what it waits for is not known yet" };
  if (pending.toolName === "AskUserQuestion") {
    const [first] = questionsOf(pending.input);
    return { id: "answer", label: "Answer Claude's question", detail: first?.question ?? "", disabled: off ?? (answerable(pending) ? undefined : "the question is in an unknown shape") };
  }
  return { id: "answer", label: `Allow or deny ${pending.displayName ?? pending.toolName}`, detail: "in the line below the chat", disabled: off };
}

/** The first of `preferred` that can be chosen, else copying, which always can. */
function firstOf(options: ChoiceOption<RcViewerAction>[], preferred: RcViewerAction[]): number {
  const found = preferred.map((id) => options.findIndex((o) => o.id === id && !o.disabled)).find((i) => i >= 0);
  return found ?? options.findIndex((o) => o.id === "copy");
}
