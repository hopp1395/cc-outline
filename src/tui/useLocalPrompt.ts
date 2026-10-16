import { useEffect, useMemo, useRef, useState } from "react";
import { detectTerminal } from "../open.js";
import { ESCAPE, keysInClaude, prepareConsoleInput, promptSteps, type ConsoleTyper, type KeyStep } from "../switchSession.js";
import type { RunningSession } from "../transcript/trash.js";
import type { PromptChannel } from "./SessionComposer.js";

/**
 * Why a prompt cannot be typed into the Claude Code `running` (the session of this machine a viewer of one session
 * shows), or undefined when it can: it runs nowhere, in the daemon without a terminal, where cco types into
 * nothing (no tmux, not Windows), or Claude waits there for a permission or an answer, which typing would give.
 */
export function localBlocked(running: RunningSession | undefined, terminal = detectTerminal(), platform: NodeJS.Platform = process.platform): string | undefined {
  if (!running) return "not running: Enter in Sessions continues it";
  if (running.kind === "bg") return running.jobId ? `background session: claude attach ${running.jobId}` : "background session: no terminal to type into";
  if (terminal !== "tmux" && platform !== "win32") return "no tmux: cco cannot type into it";
  if (running.activity === "waiting") return "Claude waits for you in its terminal";
  return undefined;
}

/**
 * The prompt line's way into a session of this machine: its prompts typed into the Claude Code that runs it, after
 * what is typed there already, and Esc to stop Claude. On Windows the PowerShell that types (`prepareConsoleInput`,
 * about a second to start) is started while the line has the keys, and again after each use.
 */
export function useLocalPrompt(running: RunningSession | undefined, focused: boolean): PromptChannel {
  const blocked = localBlocked(running);
  const pid = running?.pid;
  const typer = useRef<ConsoleTyper>(undefined);
  // Bumped after each use: the next typer starts while the line still has the keys.
  const [used, setUsed] = useState(0);
  const ahead = focused && !blocked && pid !== undefined && process.platform === "win32" && detectTerminal() !== "tmux";
  useEffect(() => {
    if (!ahead) return;
    if (!typer.current?.ready()) typer.current = prepareConsoleInput(pid!);
    return () => {
      typer.current?.cancel();
      typer.current = undefined;
    };
  }, [ahead, pid, used]);

  return useMemo((): PromptChannel => {
    const type = async (steps: KeyStep[]) => {
      if (pid === undefined || blocked) throw new Error(blocked ?? "not running");
      const ready = typer.current?.ready() ? typer.current : undefined;
      typer.current = undefined;
      const result = await keysInClaude(pid, steps, ready);
      setUsed((n) => n + 1);
      if (!result.typed) throw new Error(result.message);
    };
    return { blocked, send: (text) => type(promptSteps(text)), interrupt: () => type(ESCAPE) };
  }, [pid, blocked]);
}
