import { useState } from "react";
import { sendInterrupt, sendPrompt } from "../remote/api.js";
import { describeRemoteError } from "../remote/index.js";
import type { Layout } from "./layout.js";
import { PromptDialog } from "./PromptDialog.js";
import type { ChoiceOption } from "./resumeChoice.js";

/** What cco can do to a remote session (setting remoteControl): send a prompt, stop Claude; answering comes later. */
export type RemoteAction = "prompt" | "interrupt" | "answer";

/** A remote session as the dialogs name it. */
export interface RemoteTarget {
  id: string;
  title: string;
  /** What claude.ai says the session does: `idle`, `running`, `requires_action`. */
  workerStatus?: string;
}

/**
 * The options of a remote session's dialog by what it does, the usual one first: while it waits for an answer,
 * that (not yet: the app answers it); while Claude works, stopping it, then a prompt it takes in when it can;
 * otherwise a prompt.
 */
export function remoteOptions(workerStatus: string | undefined): ChoiceOption<RemoteAction>[] {
  const prompt = (detail: string): ChoiceOption<RemoteAction> => ({ id: "prompt", label: "Send a prompt", detail });
  const interrupt: ChoiceOption<RemoteAction> = { id: "interrupt", label: "Interrupt Claude", detail: "stops what Claude does, like Esc in the terminal" };
  if (workerStatus === "requires_action")
    return [{ id: "answer", label: "Answer it", detail: "", disabled: "not yet in cco: answer it in the Claude app" }, interrupt, prompt("Claude takes it in once answered")];
  if (workerStatus === "running") return [interrupt, prompt("Claude takes it in when it can, as if typed while it works")];
  return [prompt("Claude starts on it at once")];
}

/**
 * Sends prompts and interrupts to remote sessions: `act` runs an action of `remoteOptions`, a prompt through the
 * prompt dialog (`element`, open while `open`); `notify` hears what happened.
 */
export function useRemoteControl(layout: Layout, notify: (message: string) => void) {
  const [prompting, setPrompting] = useState<RemoteTarget>();
  const report = (done: string) => (p: Promise<void>) => p.then(() => notify(done), (err) => notify(`not sent: ${describeRemoteError(err)}`));
  const act = (action: RemoteAction, target: RemoteTarget) => {
    if (action === "prompt") return setPrompting(target);
    if (action === "interrupt") return void report("interrupt sent")(sendInterrupt(target.id));
  };
  const element = prompting && (
    <PromptDialog
      layout={layout}
      title={prompting.workerStatus === "running" ? "Send a prompt (Claude is working)" : "Send a prompt"}
      lines={[`◈ ${prompting.title}`]}
      draftKey={prompting.id}
      onSend={(text) => {
        setPrompting(undefined);
        void report("prompt sent")(sendPrompt(prompting.id, text));
      }}
      onCancel={() => setPrompting(undefined)}
    />
  );
  return { act, element, open: prompting !== undefined };
}
