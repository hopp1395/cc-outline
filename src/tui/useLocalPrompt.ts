import { useEffect, useMemo, useRef, useState } from "react";
import { attachCommand, detectTerminal } from "../open.js";
import { ESCAPE, frontBlocked, keysInClaude, prepareConsoleInput, promptSteps, questionAnswerSteps, typesIntoConsole, type ConsoleTyper, type KeyStep } from "../switchSession.js";
import type { RunningSession } from "../transcript/trash.js";
import type { PromptChannel, PromptTerminal } from "./SessionComposer.js";

/** What the prompt line says while Claude waits in the terminal of a session of this machine. */
export const WAITS_IN_TERMINAL = "Claude waits for you in its terminal";

/**
 * Why a prompt cannot be typed into the Claude Code `running` (the session of this machine a viewer of one session
 * shows), or undefined when it can: it runs nowhere, in the daemon without a terminal, where cco types into
 * nothing (no tmux or WezTerm, not Windows), or Claude waits there for a permission or an answer, which typing would give.
 */
export function localBlocked(running: RunningSession | undefined, terminal = detectTerminal(), platform: NodeJS.Platform = process.platform): string | undefined {
  if (!running) return "not running: Enter in Sessions continues it";
  if (running.kind === "bg") {
    const attach = attachCommand(running);
    return attach ? `background session: ${attach}` : "background session: no terminal to type into";
  }
  if (terminal !== "tmux" && terminal !== "wezterm" && platform !== "win32") return "no tmux or WezTerm: cco cannot type into it";
  if (running.activity === "waiting") return WAITS_IN_TERMINAL;
  return undefined;
}

/**
 * The terminal the Claude Code `running` runs in, for the prompt line (`SessionComposer`'s `terminal`): `front` brings
 * it to the front, or `why` it cannot (`frontBlocked`); `waits` while Claude waits there for something the line
 * cannot answer, unless the session is connected to claude.ai (`bridged`), where that is answered.
 */
export function terminalOf(running: RunningSession | undefined, front: () => void, bridged = false, terminal = detectTerminal() !== undefined): PromptTerminal | undefined {
  if (!running) return undefined;
  const why = frontBlocked(running, terminal);
  return { ...(why ? { why } : { front }), waits: running.activity === "waiting" && !bridged };
}

/**
 * The prompt line's way into a session of this machine: its prompts typed into the Claude Code that runs it, after
 * what is typed there already, and Esc to stop Claude. While Claude waits there, only the answer to its question
 * (`answerQuestion`: the keys of `questionAnswerSteps`), or Esc to cancel it (`cancelQuestion`), can be typed. On Windows the PowerShell that types (`prepareConsoleInput`,
 * about a second to start) is started while the line has the keys, and again after each use.
 */
export function useLocalPrompt(running: RunningSession | undefined, focused: boolean): PromptChannel {
  const blocked = localBlocked(running);
  // Waiting is the only reason it is blocked: the question's dialog can be answered with keys.
  const answers = blocked !== undefined && running?.activity === "waiting" && localBlocked({ ...running, activity: undefined }) === undefined;
  const pid = running?.pid;
  const typer = useRef<ConsoleTyper>(undefined);
  // Bumped after each use: the next typer starts while the line still has the keys.
  const [used, setUsed] = useState(0);
  const ahead = focused && (!blocked || answers) && pid !== undefined && process.platform === "win32" && typesIntoConsole();
  useEffect(() => {
    if (!ahead) return;
    if (!typer.current?.ready()) typer.current = prepareConsoleInput(pid!);
    return () => {
      typer.current?.cancel();
      typer.current = undefined;
    };
  }, [ahead, pid, used]);

  return useMemo((): PromptChannel => {
    const type = async (steps: KeyStep[], answering = false) => {
      if (pid === undefined || (blocked && !(answering && answers))) throw new Error(blocked ?? "not running");
      const ready = typer.current?.ready() ? typer.current : undefined;
      typer.current = undefined;
      const result = await keysInClaude(pid, steps, ready);
      setUsed((n) => n + 1);
      if (!result.typed) throw new Error(result.message);
    };
    return {
      blocked,
      send: (text) => type(promptSteps(text)),
      interrupt: () => type(ESCAPE),
      ...(answers && {
        answerQuestion: (questions, picks) => type(questionAnswerSteps(questions, picks), true),
        cancelQuestion: () => type(ESCAPE, true),
      }),
    };
  }, [pid, blocked, answers]);
}
