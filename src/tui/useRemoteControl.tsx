import { useEffect, useState } from "react";
import { toolInputText } from "../localRequest.js";
import { listEvents, sendInterrupt, sendPrompt, sendResponse } from "../remote/api.js";
import { describeRemoteError } from "../remote/index.js";
import { pendingRequests, type PendingRequest } from "../remote/pending.js";
import { TIMING } from "../timing.js";
import { ChoiceDialog, choiceRoom } from "./ChoiceDialog.js";
import { capLines, wrapLines, type Layout } from "./layout.js";
import { PromptDialog } from "./PromptDialog.js";
import { QuestionDialog, questionsOf } from "./QuestionDialog.js";
import type { ChoiceOption } from "./resumeChoice.js";
import { useClipboard } from "./useClipboard.js";

/** What cco can do to a remote session (setting remoteControl): send a prompt, stop Claude, answer what it waits for. */
export type RemoteAction = "prompt" | "interrupt" | "answer";

/** A remote session as the dialogs name it. */
export interface RemoteTarget {
  id: string;
  title: string;
  /** What claude.ai says the session does: `idle`, `running`, `requires_action`. */
  workerStatus?: string;
  /** What it waits for, while `requires_action`. */
  pending?: PendingRequest;
}

/** Whether `pending` is Claude's question (AskUserQuestion) rather than a tool to allow. */
const isQuestion = (pending: PendingRequest) => pending.toolName === "AskUserQuestion";

/** Whether cco can answer `pending` itself: a question it can read, or any tool to allow or deny. */
export const answerable = (pending: PendingRequest | undefined) => pending !== undefined && (!isQuestion(pending) || questionsOf(pending.input).length > 0);

/** The tool's name as the app shows it. */
const toolName = (pending: PendingRequest) => pending.displayName ?? pending.toolName;

/** The rows a request's details take at most, wrapped; a dim row names what is left over. */
const REQUEST_ROWS = 10;

/** The lines that say what a tool is to do: a command, a file, else its input's fields, wrapped to `width`. */
export function toolInputLines(pending: PendingRequest, width = 56): string[] {
  return requestRows(toolInputText(pending.input), width);
}

/** The rows a request's lines wrap into, at most `REQUEST_ROWS` of them: each row it breaks into indented two past its line's own indentation. */
export function requestRows(lines: string[], width: number): string[] {
  return capLines(
    lines.flatMap((line) => wrapLines(line, width, `${/^ */.exec(line)![0]}  `)),
    REQUEST_ROWS,
  );
}

/** What the answer option says it does, by what is asked. */
function answerOption(pending: PendingRequest | undefined): ChoiceOption<RemoteAction> {
  if (!pending) return { id: "answer", label: "Answer it", detail: "", disabled: "what it waits for is not known yet" };
  if (isQuestion(pending)) {
    const [first] = questionsOf(pending.input);
    return { id: "answer", label: "Answer Claude's question", detail: first?.question ?? "", ...(!answerable(pending) && { disabled: "the question is in an unknown shape" }) };
  }
  return { id: "answer", label: `Allow or deny ${toolName(pending)}`, detail: toolInputText(pending.input)[0] ?? "" };
}

/**
 * The options of a remote session's dialog by what it does, the usual one first: while it waits for an answer,
 * that; while Claude works, stopping it, then a prompt it takes in when it can; otherwise a prompt.
 */
export function remoteOptions(workerStatus: string | undefined, pending?: PendingRequest): ChoiceOption<RemoteAction>[] {
  const prompt = (detail: string): ChoiceOption<RemoteAction> => ({ id: "prompt", label: "Send a prompt", detail });
  const interrupt: ChoiceOption<RemoteAction> = { id: "interrupt", label: "Interrupt Claude", detail: "stops what Claude does, like Esc in the terminal" };
  if (workerStatus === "requires_action" || pending) return [answerOption(pending), interrupt, prompt("Claude takes it in once answered")];
  if (workerStatus === "running") return [interrupt, prompt("Claude takes it in when it can, as if typed while it works")];
  return [prompt("Claude starts on it at once")];
}

/** How the app answers a tool's request: allowed with its input unchanged, or denied with what the user said. */
export function permissionResponse(pending: PendingRequest, allow: boolean, message = "Denied by user"): Record<string, unknown> {
  return allow
    ? { behavior: "allow", toolUseID: pending.toolUseId, tool_name: pending.toolName, updatedInput: pending.input }
    : { behavior: "deny", message, toolUseID: pending.toolUseId };
}

type Permission = "allow" | "deny" | "reason";

/**
 * Sends prompts, interrupts and answers to remote sessions: `act` runs an action of `remoteOptions`, a prompt or an
 * answer through its dialog (`element`, open while `open`); `notify` hears what happened. `stillPending` tells
 * whether a request still waits (undefined: not known); once it no longer does, another app answered it first, and
 * its dialog closes, a text typed there copied, so it is not lost.
 */
export function useRemoteControl(layout: Layout, notify: (message: string) => void, stillPending?: (sessionId: string, requestId: string) => boolean | undefined) {
  const [prompting, setPrompting] = useState<RemoteTarget>();
  // The request being answered, and for a denial with a reason, its text window.
  const [answering, setAnswering] = useState<RemoteTarget & { pending: PendingRequest; reason?: boolean }>();
  // What was typed into an answer, for the clipboard if another app answers first.
  const [typed, setTyped] = useState("");
  const copy = useClipboard();
  const report = (done: string) => (p: Promise<void>) => p.then(() => notify(done), (err) => notify(`not sent: ${describeRemoteError(err)}`));
  const act = (action: RemoteAction, target: RemoteTarget) => {
    if (action === "prompt") return setPrompting(target);
    if (action === "interrupt") return void report("interrupt sent")(sendInterrupt(target.id));
    if (action === "answer" && answerable(target.pending)) {
      setTyped("");
      return setAnswering({ ...target, pending: target.pending! });
    }
  };
  // While a window is open, the session's own events tell at once whether another client answered: the list of the
  // Sessions view is read only every few seconds, and did not drop the request in time.
  const [answeredElsewhere, setAnsweredElsewhere] = useState<string>();
  const watched = answering && `${answering.id}#${answering.pending.requestId}`;
  useEffect(() => {
    if (!answering) return;
    const { id, pending } = answering;
    let cancelled = false;
    const check = () =>
      listEvents(id).then(
        ({ events }) => {
          // Only once the request is among the events read: before that, nothing says it was answered.
          const asked = events.some((e) => e.payload.type === "control_request" && e.payload.request_id === pending.requestId);
          if (!cancelled && asked && !pendingRequests(events).some((p) => p.requestId === pending.requestId)) setAnsweredElsewhere(watched);
        },
        () => {},
      );
    void check();
    const timer = setInterval(() => void check(), TIMING.remotePoll);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [watched]);
  // Answered elsewhere (the app, the terminal): the dialog has nothing left to answer.
  const gone = answering && (answeredElsewhere === watched || stillPending?.(answering.id, answering.pending.requestId) === false);
  useEffect(() => {
    if (!gone) return;
    setAnswering(undefined);
    if (!typed.trim()) return notify("already answered in another app");
    void copy(typed).then(
      () => notify("already answered in another app; what you typed is copied"),
      () => notify("already answered in another app"),
    );
  }, [gone]);

  const answer = (response: Record<string, unknown>, done: string) => {
    if (!answering) return;
    const { id, pending } = answering;
    setAnswering(undefined);
    void report(done)(sendResponse(id, pending.requestId, response));
  };
  let element;
  if (answering && isQuestion(answering.pending)) {
    const { pending } = answering;
    element = (
      <QuestionDialog
        layout={layout}
        title={`◈ ${answering.title}: Claude asks`}
        questions={questionsOf(pending.input)}
        // As the app: the questions as asked, with the answers by question.
        onSend={(answers) => answer({ behavior: "allow", toolUseID: pending.toolUseId, tool_name: pending.toolName, updatedInput: { ...pending.input, answers } }, "answer sent")}
        onCancel={() => setAnswering(undefined)}
        onTyped={setTyped}
      />
    );
  } else if (answering?.reason) {
    const { pending } = answering;
    element = (
      <PromptDialog
        layout={layout}
        title={`Deny ${toolName(pending)}, saying why`}
        lines={[`◈ ${answering.title}`, ...toolInputLines(pending)]}
        draftKey={`${answering.id}#${pending.requestId}`}
        onSend={(text) => answer(permissionResponse(pending, false, text), "denied")}
        onCancel={() => setAnswering({ ...answering, reason: false })}
        onTyped={setTyped}
      />
    );
  } else if (answering) {
    const { pending } = answering;
    const options: ChoiceOption<Permission>[] = [
      { id: "allow", label: "Allow", detail: "this once, as the app does" },
      { id: "deny", label: "Deny", detail: "Claude is told no and goes on" },
      { id: "reason", label: "Deny, saying why…", detail: "Claude reads what you write" },
    ];
    element = (
      <ChoiceDialog
        key={pending.requestId}
        layout={layout}
        choice={{
          title: `◈ ${answering.title}: allow ${toolName(pending)}?`,
          lines: requestRows([...toolInputText(pending.input), ...(pending.description ? [pending.description] : [])], choiceRoom(layout)),
          options,
          initial: 0,
          onChoose: (choice: Permission) => {
            if (choice === "reason") return setAnswering({ ...answering, reason: true });
            answer(permissionResponse(pending, choice === "allow"), choice === "allow" ? "allowed" : "denied");
          },
        }}
        onClose={() => setAnswering(undefined)}
      />
    );
  } else if (prompting) {
    element = (
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
  }
  return { act, element, open: prompting !== undefined || answering !== undefined };
}
