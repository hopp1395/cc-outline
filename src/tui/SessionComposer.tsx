import { Box, measureElement, Text, useInput, usePaste, type DOMElement } from "ink";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTypedPrompt, type Turn } from "../transcript/parse.js";
import { editLine, type LineState } from "../filter.js";
import { localRequestLines, type LocalRequest } from "../localRequest.js";
import { takeCommand, unknownCommand, type CommandSource } from "../slashCommands.js";
import type { PendingRequest } from "../remote/pending.js";
import { TIMING } from "../timing.js";
import { fitUsage, usageParts, usageWidth, type RemoteUsage } from "../remote/usage.js";
import { UsageText } from "./UsageText.js";
import { CommandList, pickerFirst, pickerRows, useCommandPicker, useSlashCommands } from "./CommandPicker.js";
import { useMouse } from "./mouse.js";
import { moveRow, pastable, promptRows } from "./PromptDialog.js";
import { annotationsOf, QuestionDialog, questionsOf, type Answer, type Question } from "./QuestionDialog.js";
import { truncate, type Layout } from "./layout.js";
import { useClipboard } from "./useClipboard.js";
import { WAITS_IN_TERMINAL } from "./useLocalPrompt.js";
import { permissionResponse, requestRows, toolInputLines } from "./useRemoteControl.js";

/** The rows of text the prompt line grows to; a longer prompt scrolls with the cursor. */
const MAX_ROWS = 6;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const EMPTY: LineState = { text: "", cursor: 0, selected: false };

/** The rows of `line`, at most `MAX_ROWS` around the cursor, with the cursor drawn inverse. */
function TextRows({ line, room, lead, cursor = true }: { line: LineState; room: number; lead: string; cursor?: boolean }) {
  const { rows, row, column } = promptRows(line.text, line.cursor, room);
  const first = Math.max(0, Math.min(row - MAX_ROWS + 1, rows.length - MAX_ROWS));
  return (
    <>
      {rows.slice(first, first + MAX_ROWS).map((r, i) => {
        const at = first + i;
        const head = <Text color="cyan">{at === 0 ? lead : " ".repeat(lead.length)}</Text>;
        if (at !== row || !cursor) return <Text key={at} wrap="truncate">{head}{r.text}</Text>;
        const rest = r.text.slice(column);
        const char = [...graphemes.segment(rest)][0]?.segment ?? "";
        return (
          <Text key={at} wrap="truncate">
            {head}
            {r.text.slice(0, column)}
            <Text inverse>{char || " "}</Text>
            {rest.slice(char.length)}
          </Text>
        );
      })}
    </>
  );
}

/**
 * The composer's frame: a line above and below, open to the sides so the text has the pane's width. The line below
 * carries `usage` at its right end, like Claude Code's status line: the context of a remote session's last answer and
 * the account's windows, `─── Ctx 62k · 5h 23% ↻ 2h14m · 7d 97% ↻ 3d4h ──`, shortened to fit (`fitUsage`). It reads the
 * clock each minute, so the times left count down.
 */
function Frame({ width, color, usage, children }: { width: number; color: string; usage?: RemoteUsage; children: ReactNode }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!usage) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [Boolean(usage)]);
  // At least two ─ before it, a space on each side and two ─ after it.
  const parts = usage ? fitUsage(usageParts(usage, now), width - 6) : [];
  const line = (n: number) => <Text color={color}>{"─".repeat(Math.max(0, n))}</Text>;
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Text wrap="truncate">{line(width)}</Text>
      {children}
      {parts.length ? (
        <Text wrap="truncate">
          {line(width - usageWidth(parts) - 4)}{" "}
          <UsageText parts={parts} stale={usage?.stale} />{" "}
          {line(2)}
        </Text>
      ) : (
        <Text wrap="truncate">{line(width)}</Text>
      )}
    </Box>
  );
}

/**
 * What ↑ at the prompt line brings back: the prompts typed in `turns` (also queued ones, `/` and `!` commands, wherever
 * they were typed), the newest first, each text once where it was used last. A prompt of images alone has no text to
 * bring back. A `/` command Claude Code did not know is there too, to be put right: as a turn of its own, or, typed
 * while Claude worked, as the warning in the running turn.
 */
export function promptHistory(turns: readonly Turn[]): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  const add = (prompt: string) => {
    const text = prompt.trim();
    if (!text || /^\[(Image|\d+ images)\]$/.test(text) || seen.has(text)) return;
    seen.add(text);
    texts.push(text);
  };
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    for (let j = turn.blocks.length - 1; j >= 0; j--) {
      const b = turn.blocks[j]!;
      if (b.kind === "notice" && b.command && !turn.unknownCommand) add(b.command);
    }
    if (isTypedPrompt(turn) || turn.unknownCommand) add(turn.prompt);
  }
  return texts;
}

type Permission = "allow" | "deny" | "reason";
const PERMISSIONS: { id: Permission; label: string }[] = [
  { id: "allow", label: "Allow" },
  { id: "deny", label: "Deny" },
  { id: "reason", label: "Deny, saying why…" },
];

/** Asks the prompt line how many sessions have a draft not sent yet (the Remote Control Viewer, before a restart). */
export type UnsentDrafts = { current?: () => number };

/**
 * Where the prompt line's text goes: a remote session's events on claude.ai, or the Claude Code that runs a session of
 * this machine (typed in). Each call rejects with an `Error` whose message says why it failed.
 */
export interface PromptChannel {
  /** Why nothing can be sent now (it runs nowhere, steer remote is off, …); the line shows it in place of the text. */
  blocked?: string;
  send(text: string): Promise<void>;
  /** Stops Claude while it works. */
  interrupt(): Promise<void>;
  /** Answers a request the session waits for; only a remote session's are known. */
  respond?(requestId: string, response: Record<string, unknown>): Promise<void>;
  /**
   * Answers the question a session of this machine waits for in its terminal (its hooks recorded it, `asked`): the
   * picks typed into its Claude Code's dialog. Only where keys reach it.
   */
  answerQuestion?(questions: Question[], picks: Answer[]): Promise<void>;
  /** Cancels that question as Esc in its terminal does (Claude hears the user declined it). Where `answerQuestion` is. */
  cancelQuestion?(): Promise<void>;
}

/**
 * The terminal the Claude Code of a session of this machine runs in (`terminalOf`): `front` brings it to the front, or
 * `why` it cannot. `waits`: Claude waits there for something the line cannot answer (a dialog the hooks do not see,
 * a permission), and not through claude.ai; the line then keeps the keys, and Enter brings that terminal to the front.
 */
export interface PromptTerminal {
  front?: () => void;
  why?: string;
  waits: boolean;
}

/**
 * What cco typed into a session's question dialog (`key`: the question as its hooks recorded it), and whether
 * Claude still waits for that same question `TIMING.answerCheck` after the last key: then it did not arrive.
 */
interface TypedIn {
  key: string;
  kind: "answer" | "cancel";
  picks?: Answer[];
  /** All keys are typed; the check runs from then on. */
  done: boolean;
  stuck: boolean;
}

/**
 * The bottom of a viewer of one session, like Claude Code's: a prompt line that grows with its text (Enter sends,
 * Ctrl+J starts a new line, ↑↓ move between its rows and, on the first or last, through the session's `history`), through
 * `channel`; while a remote session's Claude waits for an answer, the permission
 * (allow, deny, deny saying why) or the question takes its place. It has the keys while `focused`: Esc (or Tab) hands
 * them to the chat, Esc while Claude works stops it, as in Claude Code. While the channel is blocked it says why and
 * takes no keys, except while Claude waits in its `terminal`: then Enter brings that to the front. `onHeight` hears
 * the rows it takes, so the chat above leaves them.
 */
export function SessionComposer({
  layout,
  channel,
  title,
  working,
  pending,
  focused,
  onFocus,
  notify,
  onHeight,
  draftKey,
  hint = ["Tab", "write a prompt"],
  asked,
  terminal,
  commands,
  usage,
  history = [],
  unsent,
}: {
  layout: Layout;
  channel: PromptChannel;
  /** The session's title, in the question's frame (a remote one's starts with ◈). */
  title: string;
  /** Claude works in the session: a prompt waits until it can, and Esc stops it. */
  working: boolean;
  /** What the worker waits for, the oldest first. */
  pending?: PendingRequest;
  focused: boolean;
  onFocus: (focused: boolean) => void;
  notify: (message: string) => void;
  onHeight: (rows: number) => void;
  /**
   * The session the line writes to, where it changes (the Remote Control Viewer): each keeps its own draft, so a text is never sent
   * to another session than the one it was written for.
   */
  draftKey?: string;
  /** What the line says while it does not have the keys: the key that gives them, and what for. */
  hint?: [string, string];
  /**
   * What a session of this machine waits for, as its hooks recorded it: shown in the line's place while it waits,
   * read-only, since it is answered in its terminal; a question the channel can
   * answer (`answerQuestion`) gets the question dialog, its answer typed in there (Esc there types Esc: the question is
   * cancelled). Should Claude still wait for that question after the keys, the line says the keys did not arrive and,
   * while it has the keys, `r` types the answer again, Esc cancels and Enter brings its terminal to the front.
   */
  asked?: LocalRequest;
  /** The terminal a session of this machine runs in: brought to the front with Enter where Claude waits there. */
  terminal?: PromptTerminal;
  /** Where the session's `/` commands come from, for the list a `/` at the prompt's start opens (not while the line is blocked). */
  commands?: CommandSource;
  /** What its frame's bottom line shows at the right (the Remote Control Viewer): a remote session's context and the account's windows. */
  usage?: RemoteUsage;
  /**
   * The session's prompts, the newest first (`promptHistory`): ↑ on the line's first row brings back the one before,
   * ↓ on its last the one after, and past the newest what was written before.
   */
  history?: readonly string[];
  /** Filled with how many sessions have a draft (`draftKey`) that was not sent: what a restart of the Remote Control Viewer would lose. */
  unsent?: UnsentDrafts;
}) {
  const [line, setLineState] = useState<LineState>(EMPTY);
  // Browsing the history: the prompt brought back (its place found by its text, as new prompts come in), and what was
  // written before, for ↓ past the newest.
  const [browse, setBrowse] = useState<{ text: string; index: number; draft: LineState }>();
  const drafts = useRef(new Map<string, LineState>()).current;
  const keyNow = useRef(draftKey);
  if (unsent) unsent.current = () => [...drafts.values()].filter((d) => d.text.trim() !== "").length;
  // Gone (no session selected): its drafts are gone with it.
  useEffect(
    () => () => {
      if (unsent) unsent.current = undefined;
    },
    [],
  );
  const setLine = (next: LineState) => {
    setLineState(next);
    if (keyNow.current !== undefined) drafts.set(keyNow.current, next);
  };
  // Another session: its own draft, and what was asked of the one before is not "answered elsewhere".
  // Enter on a `/` command the session does not know: the text warned about, and the command it most likely meant.
  const [warned, setWarned] = useState<{ text: string; name: string; suggestion?: string }>();
  if (keyNow.current !== draftKey) {
    keyNow.current = draftKey;
    setLineState(draftKey === undefined ? EMPTY : (drafts.get(draftKey) ?? EMPTY));
    setBrowse(undefined);
    setWarned(undefined);
  }
  const [sending, setSending] = useState(false);
  const [choice, setChoice] = useState(0);
  // Deny, saying why: the reason's text, in place of the options.
  const [reason, setReason] = useState<LineState>();
  const [typed, setTyped] = useState("");
  const answered = useRef<string>(undefined);
  const copy = useClipboard();
  // A request can be answered only where the channel can respond (remote).
  const request = channel.respond && !channel.blocked ? pending : undefined;
  // A question of this machine's session, answered by typing into its terminal: once, and not one answered elsewhere.
  const askedKey = asked ? `${asked.sessionId}:${asked.at}` : undefined;
  const localQuestions = !request && asked?.kind === "question" && channel.answerQuestion && answered.current !== askedKey ? questionsOf(asked.input) : [];
  const localQuestion = localQuestions.length > 0;
  const isQuestion = (request?.toolName === "AskUserQuestion" && questionsOf(request.input).length > 0) || localQuestion;
  // What was typed into its dialog for the question it waits for, once Claude still waits for it after the keys.
  const [typedIn, setTypedIn] = useState<TypedIn>();
  const stuck = typedIn?.stuck && typedIn.key === askedKey && asked?.kind === "question" && channel.answerQuestion ? typedIn : undefined;
  useEffect(() => {
    if (!typedIn?.done || typedIn.stuck || typedIn.key !== askedKey) return;
    // Another question, or none: Claude took it. The same one still after a moment: the keys did not arrive.
    const timer = setTimeout(() => setTypedIn((t) => (t === typedIn ? { ...t, stuck: true } : t)), TIMING.answerCheck);
    return () => clearTimeout(timer);
  }, [typedIn, askedKey]);
  /** Types the answer (`picks`) into the dialog of the question its Claude Code waits for, or Esc, which cancels it. */
  const typeIn = (kind: TypedIn["kind"], picks?: Answer[]) => {
    const key = askedKey;
    if (!key || !asked) return;
    const run = kind === "answer" ? channel.answerQuestion?.(questionsOf(asked.input), picks ?? []) : channel.cancelQuestion?.();
    if (!run) return;
    answered.current = key;
    setTyped("");
    const entry: TypedIn = { key, kind, picks, done: false, stuck: false };
    setTypedIn(entry);
    run.then(
      () => {
        setTypedIn((t) => (t === entry ? { ...entry, done: true } : t));
        notify(kind === "answer" ? "answer typed into its Claude Code" : "Esc typed into its Claude Code: the question is cancelled");
      },
      (err: Error) => {
        // Not typed: the dialog comes back, to try again or answer in its terminal.
        if (answered.current === key) answered.current = undefined;
        setTypedIn((t) => (t === entry ? undefined : t));
        notify(`not typed: ${err.message}`);
      },
    );
  };

  // A new request starts on Allow; one answered elsewhere drops what was typed for it, into the clipboard.
  const shown = useRef<{ key?: string; id?: string }>({ key: draftKey });
  useEffect(() => {
    const before = shown.current;
    shown.current = { key: draftKey, id: request?.requestId };
    if (before.id === request?.requestId && before.key === draftKey) return;
    setChoice(0);
    setReason(undefined);
    // Another session selected: its request is new, not answered elsewhere.
    if (before.key !== draftKey) return setTyped("");
    if (before.id && before.id !== answered.current) {
      const text = typed.trim();
      setTyped("");
      if (text) void copy(text).then(() => notify("already answered in another app; what you typed is copied"), () => notify("already answered in another app"));
      else notify("already answered in another app");
    }
  }, [request?.requestId, draftKey]);

  // Claude waits in its terminal for something the line cannot answer (a dialog its hooks do not see, a permission):
  // Enter brings that terminal to the front, where it can be.
  const front = terminal?.front;
  const waitsThere = !!terminal?.waits && channel.blocked !== undefined && !request && !localQuestion && !stuck;
  // Blocked while it has the keys (the session ended, Claude waits in its terminal): the chat takes them back, except
  // where keys typed into its dialog did not arrive (again, cancel, to the front), or Enter brings its terminal forward.
  useEffect(() => {
    if (focused && channel.blocked && !request && !localQuestion && !stuck && !(waitsThere && front)) onFocus(false);
  }, [focused, channel.blocked, request, localQuestion, stuck, waitsThere, front]);

  // A prompt brought back unchanged keeps the list of / commands closed, so ↑↓ go on through the history.
  const recalled = browse !== undefined && line.text === browse.text;
  const picker = useCommandPicker(recalled ? "" : line.text, recalled ? 0 : line.cursor, focused && !channel.blocked && !request ? commands : undefined);
  // The session's commands, also for a prompt brought back: Enter checks its command against them.
  const known = useSlashCommands(focused && !channel.blocked && !request ? commands : undefined, line.text.startsWith("/"));
  // The warning holds while the text is the one warned about: a second Enter sends it all the same.
  const warning = warned && warned.text === line.text ? warned : undefined;
  const width = layout.columns;
  const room = width - 2;
  // The rows the text wraps to (`TextRows`' room).
  const textRoom = room - 2;

  const box = useRef<DOMElement>(null);
  const height = useRef(0);
  useEffect(() => {
    if (!box.current) return;
    height.current = measureElement(box.current).height;
    onHeight(height.current);
  });

  // The list is the composer's top, below its frame, at the bottom of the screen: a click takes a command, the wheel moves.
  useMouse((e) => {
    const row = e.y - (layout.rows - height.current) - 1;
    if (e.kind === "wheel") return picker.move(e.delta);
    if (e.kind === "click" && row >= 0 && row < pickerRows(picker)) setLine({ ...picker.take(pickerFirst(picker) + row), selected: false });
  }, focused && picker.open);

  const report = (done: string) => (p: Promise<void>) => p.then(() => notify(done), (err: Error) => notify(`not sent: ${err.message}`));
  const answer = (response: Record<string, unknown>, done: string) => {
    if (!request || !channel.respond) return;
    answered.current = request.requestId;
    setReason(undefined);
    setTyped("");
    void report(done)(channel.respond(request.requestId, response));
  };
  const send = (typed = line.text) => {
    const text = typed.trim();
    if (!text || sending || channel.blocked) return;
    setSending(true);
    const key = keyNow.current;
    channel.send(text).then(
      () => {
        // Sent: that session's draft is gone, also when another one is selected by now.
        if (key !== undefined) drafts.delete(key);
        if (keyNow.current === key) {
          setLineState(EMPTY);
          setBrowse(undefined);
          setWarned(undefined);
        }
        setSending(false);
      },
      (err: Error) => {
        setSending(false);
        notify(`not sent: ${err.message}`);
      },
    );
  };
  // Where in the history the line is: the prompt brought back, found again by its text when new ones came in.
  const browsed = browse ? (history.indexOf(browse.text) >= 0 ? history.indexOf(browse.text) : Math.min(browse.index, history.length - 1)) : -1;
  const recall = (index: number, atEnd: boolean) => {
    const text = history[index]!;
    // The cursor where the next key in the same direction goes on browsing: on the first row going back, the last going on.
    setLine({ text, cursor: atEnd ? text.length : 0, selected: false });
    setBrowse({ text, index, draft: browse?.draft ?? line });
  };
  const arrow = (step: -1 | 1) => {
    const moved = moveRow(line.text, line.cursor, textRoom, step);
    if (moved !== undefined) return setLine({ ...line, cursor: moved, selected: false });
    if (step < 0) return browsed + 1 < history.length && recall(browsed + 1, false);
    if (!browse) return;
    if (browsed > 0) return recall(browsed - 1, true);
    setBrowse(undefined);
    setLine(browse.draft);
  };
  const escape = () => {
    if (working && !request && !channel.blocked) return void report("interrupt sent")(channel.interrupt());
    onFocus(false);
  };

  useInput(
    (input, key) => {
      if (stuck) {
        if (key.tab) return onFocus(false);
        if (key.escape) return typeIn("cancel");
        if (input === "r" && stuck.kind === "answer") return typeIn("answer", stuck.picks);
        if (key.return) front?.();
        return;
      }
      if (waitsThere) {
        if (key.tab || key.escape) return onFocus(false);
        if (key.return) front?.();
        return;
      }
      // The command it most likely meant, in place of the one warned about; its args stay.
      if (key.tab && warning?.suggestion && !picker.open && !request) return setLine({ ...takeCommand(line.text, warning.suggestion), selected: false });
      if (key.tab && !picker.open) return onFocus(false);
      if (key.pageUp || key.pageDown) return;
      if (reason) {
        if (key.escape) return setReason(undefined);
        if (input === "\n" || (key.ctrl && input === "j")) return setReason({ ...reason, text: reason.text.slice(0, reason.cursor) + "\n" + reason.text.slice(reason.cursor), cursor: reason.cursor + 1 });
        if (key.return) return reason.text.trim() && answer(permissionResponse(request!, false, reason.text.trim()), "denied");
        const next = editLine(reason, input, key);
        if (next !== reason) {
          setReason(next);
          setTyped(next.text);
        }
        return;
      }
      if (request && !isQuestion) {
        if (key.escape) return onFocus(false);
        if (key.upArrow || key.downArrow) return setChoice((c) => (c + (key.upArrow ? -1 : 1) + PERMISSIONS.length) % PERMISSIONS.length);
        const digit = Number(input);
        const pick = key.return ? choice : Number.isInteger(digit) && digit >= 1 && digit <= PERMISSIONS.length ? digit - 1 : -1;
        if (pick < 0) return;
        const id = PERMISSIONS[pick]!.id;
        if (id === "reason") return setReason(EMPTY);
        return answer(permissionResponse(request, id === "allow"), id === "allow" ? "allowed" : "denied");
      }
      if (picker.open) {
        if (key.upArrow || key.downArrow) return picker.move(key.upArrow ? -1 : 1);
        if (key.escape) return picker.close();
        if (key.tab || key.return) {
          const taken = picker.take();
          setLine({ ...taken, selected: false });
          if (key.return) send(taken.text);
          return;
        }
      }
      if (key.escape) return escape();
      if ((key.upArrow || key.downArrow) && !key.ctrl && !key.meta && !key.shift) return void arrow(key.upArrow ? -1 : 1);
      if (input === "\n" || (key.ctrl && input === "j")) return setLine({ text: line.text.slice(0, line.cursor) + "\n" + line.text.slice(line.cursor), cursor: line.cursor + 1, selected: false });
      if (key.return) {
        // A command Claude Code would not know: said first, sent on a second Enter (the list may lack some).
        const unknown = warning ? undefined : unknownCommand(line.text, known);
        if (unknown) return setWarned({ text: line.text, ...unknown });
        return send();
      }
      const next = editLine(line, input, key);
      if (next !== line) setLine(next);
    },
    { isActive: focused && !isQuestion },
  );
  usePaste(
    (text) => {
      if (stuck || waitsThere) return;
      const add = pastable(text);
      if (reason) return setReason({ ...reason, text: reason.text.slice(0, reason.cursor) + add + reason.text.slice(reason.cursor), cursor: reason.cursor + add.length });
      if (!request) setLine({ text: line.text.slice(0, line.cursor) + add + line.text.slice(line.cursor), cursor: line.cursor + add.length, selected: false });
    },
    { isActive: focused && !isQuestion },
  );

  const keys = (items: [string, string][]) => (
    <Text wrap="truncate" dimColor={!focused}>
      {items.map(([k, what], i) => (
        <Text key={i}>
          <Text color="yellow">{k}</Text> {what}
          {"  "}
        </Text>
      ))}
    </Text>
  );

  // Claude waits in its terminal: Enter there brings it to the front.
  const frontKeys = keys(focused ? [["Enter", "bring its terminal to the front"], ["Esc", "chat"]] : [[hint[0], "bring its terminal to the front"]]);

  let body;
  let color = "yellow";
  if (localQuestion) {
    body = (
      <QuestionDialog
        key={askedKey}
        inline
        active={focused}
        layout={layout}
        title={`Claude asks · ${truncate(title, 40)}`}
        questions={localQuestions}
        onSend={(_, picks) => {
          onFocus(false);
          typeIn("answer", picks);
        }}
        onCancel={() => {
          onFocus(false);
          typeIn("cancel");
        }}
        onLeave={() => onFocus(false)}
        onTyped={setTyped}
      />
    );
  } else if (request && isQuestion) {
    const questions = questionsOf(request.input);
    body = (
      <QuestionDialog
        inline
        active={focused}
        layout={layout}
        title={`Claude asks · ${truncate(title, 40)}`}
        questions={questions}
        onSend={(answers, picks) => {
          // With previews, Claude Code also hands Claude the chosen preview, or the note typed instead.
          const annotations = annotationsOf(questions, picks);
          answer({ behavior: "allow", toolUseID: request.toolUseId, tool_name: request.toolName, updatedInput: { ...request.input, answers, ...(annotations && { annotations }) } }, "answer sent");
        }}
        onCancel={() => answer(permissionResponse(request, false, "The user declined to answer"), "question cancelled")}
        onLeave={() => onFocus(false)}
        onTyped={setTyped}
      />
    );
  } else if (request) {
    body = (
      <>
        <Text bold color="yellow" wrap="truncate">
          {`Allow ${request.displayName ?? request.toolName}?`}
        </Text>
        {toolInputLines(request, room).map((l, i) => (
          <Text key={i} wrap="truncate">
            {l}
          </Text>
        ))}
        {reason ? (
          <>
            <Text dimColor>Why? Claude reads it.</Text>
            <TextRows line={reason} room={room - 2} lead="› " />
            {keys([["Enter", "deny"], ["^J", "new line"], ["Esc", "back"]])}
          </>
        ) : (
          <>
            {PERMISSIONS.map((p, i) => (
              <Text key={p.id} wrap="truncate">
                <Text color="cyan">{i === choice && focused ? "›" : " "}</Text>
                {` ${i + 1}. `}
                <Text bold={i === choice}>{p.label}</Text>
              </Text>
            ))}
            {keys(focused ? [["↑↓", "choose"], ["Enter", "answer"], ["1-3", ""], ["Esc", "chat"]] : [[hint[0], "answer it"]])}
          </>
        )}
      </>
    );
  } else if (channel.blocked && asked) {
    const request = asked;
    body = (
      <>
        <Text bold color="yellow" wrap="truncate">
          {request.kind === "question" ? `Claude asks · ${truncate(title, 40)}` : `Allow ${request.toolName}? · ${truncate(title, 40)}`}
        </Text>
        {requestRows(localRequestLines(request), room).map((l, i) => (
          <Text key={i} wrap="truncate">
            {l}
          </Text>
        ))}
        {stuck ? (
          <>
            <Text color="yellow" wrap="truncate">
              {stuck.kind === "answer"
                ? "The answer did not arrive: Claude still asks. Its dialog there may be half filled in."
                : "Not cancelled: Claude still asks. Its dialog there may be in its notes field."}
            </Text>
            {keys(
              focused
                ? [
                    ...(stuck.kind === "answer" ? [["r", "type the answer again"] as [string, string]] : []),
                    ["Esc", "cancel the question"],
                    ...(front ? [["Enter", "bring its terminal to the front"] as [string, string]] : []),
                    ["Tab", "chat"],
                  ]
                : [[hint[0], "try again or cancel"]],
            )}
          </>
        ) : (
          <>
            <Text dimColor wrap="truncate">
              {`Answered in its terminal${waitsThere && !front && terminal?.why ? ` · ${terminal.why}` : ""}`}
            </Text>
            {waitsThere && front && frontKeys}
          </>
        )}
      </>
    );
  } else if (waitsThere) {
    body = (
      <>
        <Text wrap="truncate">
          {"› "}
          {WAITS_IN_TERMINAL}
          {!front && terminal?.why ? <Text dimColor>{` · ${terminal.why}`}</Text> : ""}
        </Text>
        {front && frontKeys}
      </>
    );
  } else if (channel.blocked) {
    color = "gray";
    body = (
      <Text dimColor wrap="truncate">
        {"› "}
        {channel.blocked}
      </Text>
    );
  } else {
    color = focused ? "cyan" : "gray";
    body = (
      <>
        <CommandList picker={picker} width={room} />
        {line.text || focused ? <TextRows line={line} room={textRoom} lead="› " cursor={focused} /> : <Text dimColor>{"› "}</Text>}
        {warning && (
          <Text color="yellow" wrap="truncate">
            {`⚠ /${warning.name} is no command of this session${warning.suggestion ? ` · did you mean /${warning.suggestion}?` : ""}`}
          </Text>
        )}
        {focused && warning
          ? keys([...(warning.suggestion ? [["Tab", `take /${warning.suggestion}`] as [string, string]] : []), ["Enter", "send anyway"], ["Esc", working ? "stop Claude" : "chat"]])
          : focused && picker.open
          ? keys([["Tab", "take"], ["Enter", "take and send"], ["↑↓", "choose"], ["Esc", "close the list"]])
          : focused
          ? keys([["Enter", sending ? "sending…" : working ? "send (Claude takes it in when it can)" : "send"], ["^J", "new line"], ["Esc", working ? "stop Claude" : "chat"], ["PgUp/Dn", "scroll"], ...(history.length > 0 ? [["↑↓", "history"] as [string, string]] : [])])
          : keys([hint])}
      </>
    );
  }
  return (
    <Box ref={box} flexDirection="column" flexShrink={0}>
      <Frame width={width} color={color} usage={usage}>
        {body}
      </Frame>
    </Box>
  );
}
