import { Box, measureElement, Text, useInput, usePaste, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import { editLine, type LineState } from "../filter.js";
import type { PendingRequest } from "../remote/pending.js";
import { pastable, promptRows } from "./PromptDialog.js";
import { QuestionDialog, questionsOf } from "./QuestionDialog.js";
import { truncate, type Layout } from "./layout.js";
import { useClipboard } from "./useClipboard.js";
import { permissionResponse, toolInputLines } from "./useRemoteControl.js";

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

type Permission = "allow" | "deny" | "reason";
const PERMISSIONS: { id: Permission; label: string }[] = [
  { id: "allow", label: "Allow" },
  { id: "deny", label: "Deny" },
  { id: "reason", label: "Deny, saying why…" },
];

/**
 * Where the prompt line's text goes: a remote session's events on claude.ai, or the Claude Code that runs a session of
 * this machine (typed in). Each call rejects with an `Error` whose message says why it failed.
 */
export interface PromptChannel {
  /** Why nothing can be sent now (it runs nowhere, remote control is off, …); the line shows it in place of the text. */
  blocked?: string;
  send(text: string): Promise<void>;
  /** Stops Claude while it works. */
  interrupt(): Promise<void>;
  /** Answers a request the session waits for; only a remote session's are known. */
  respond?(requestId: string, response: Record<string, unknown>): Promise<void>;
}

/**
 * The bottom of a viewer of one session, like Claude Code's: a prompt line that grows with its text (Enter sends,
 * Ctrl+J starts a new line), through `channel`; while a remote session's Claude waits for an answer, the permission
 * (allow, deny, deny saying why) or the question takes its place. It has the keys while `focused`: Esc (or Tab) hands
 * them to the chat, Esc while Claude works stops it, as in Claude Code. While the channel is blocked it says why and
 * takes no keys. `onHeight` hears the rows it takes, so the chat above leaves them.
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
   * The session the line writes to, where it changes (the keeper): each keeps its own draft, so a text is never sent
   * to another session than the one it was written for.
   */
  draftKey?: string;
  /** What the line says while it does not have the keys: the key that gives them, and what for. */
  hint?: [string, string];
}) {
  const [line, setLineState] = useState<LineState>(EMPTY);
  const drafts = useRef(new Map<string, LineState>()).current;
  const keyNow = useRef(draftKey);
  const setLine = (next: LineState) => {
    setLineState(next);
    if (keyNow.current !== undefined) drafts.set(keyNow.current, next);
  };
  // Another session: its own draft, and what was asked of the one before is not "answered elsewhere".
  if (keyNow.current !== draftKey) {
    keyNow.current = draftKey;
    setLineState(draftKey === undefined ? EMPTY : (drafts.get(draftKey) ?? EMPTY));
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
  const isQuestion = request?.toolName === "AskUserQuestion" && questionsOf(request.input).length > 0;

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

  // Blocked while it has the keys (the session ended, Claude waits in its terminal): the chat takes them back.
  useEffect(() => {
    if (focused && channel.blocked && !request) onFocus(false);
  }, [focused, channel.blocked, request]);

  const box = useRef<DOMElement>(null);
  useEffect(() => {
    if (box.current) onHeight(measureElement(box.current).height);
  });

  const report = (done: string) => (p: Promise<void>) => p.then(() => notify(done), (err: Error) => notify(`not sent: ${err.message}`));
  const answer = (response: Record<string, unknown>, done: string) => {
    if (!request || !channel.respond) return;
    answered.current = request.requestId;
    setReason(undefined);
    setTyped("");
    void report(done)(channel.respond(request.requestId, response));
  };
  const send = () => {
    const text = line.text.trim();
    if (!text || sending || channel.blocked) return;
    setSending(true);
    const key = keyNow.current;
    channel.send(text).then(
      () => {
        // Sent: that session's draft is gone, also when another one is selected by now.
        if (key !== undefined) drafts.delete(key);
        if (keyNow.current === key) setLineState(EMPTY);
        setSending(false);
      },
      (err: Error) => {
        setSending(false);
        notify(`not sent: ${err.message}`);
      },
    );
  };
  const escape = () => {
    if (working && !request && !channel.blocked) return void report("interrupt sent")(channel.interrupt());
    onFocus(false);
  };

  useInput(
    (input, key) => {
      if (key.tab) return onFocus(false);
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
      if (key.escape) return escape();
      if (input === "\n" || (key.ctrl && input === "j")) return setLine({ text: line.text.slice(0, line.cursor) + "\n" + line.text.slice(line.cursor), cursor: line.cursor + 1, selected: false });
      if (key.return) return send();
      const next = editLine(line, input, key);
      if (next !== line) setLine(next);
    },
    { isActive: focused && !isQuestion },
  );
  usePaste(
    (text) => {
      const add = pastable(text);
      if (reason) return setReason({ ...reason, text: reason.text.slice(0, reason.cursor) + add + reason.text.slice(reason.cursor), cursor: reason.cursor + add.length });
      if (!request) setLine({ text: line.text.slice(0, line.cursor) + add + line.text.slice(line.cursor), cursor: line.cursor + add.length, selected: false });
    },
    { isActive: focused && !isQuestion },
  );

  const width = layout.columns;
  const room = width - 4 - 2;
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

  let body;
  if (request && isQuestion) {
    body = (
      <QuestionDialog
        inline
        active={focused}
        layout={layout}
        title={`Claude asks · ${truncate(title, 40)}`}
        questions={questionsOf(request.input)}
        onSend={(answers) => answer({ behavior: "allow", toolUseID: request.toolUseId, tool_name: request.toolName, updatedInput: { ...request.input, answers } }, "answer sent")}
        onCancel={() => onFocus(false)}
        onTyped={setTyped}
      />
    );
  } else if (request) {
    body = (
      <Box flexDirection="column" width={width} borderStyle="round" borderColor="yellow" paddingX={1} flexShrink={0}>
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
      </Box>
    );
  } else if (channel.blocked) {
    body = (
      <Box flexDirection="column" width={width} borderStyle="round" borderColor="gray" paddingX={1} flexShrink={0}>
        <Text dimColor wrap="truncate">
          {"› "}
          {channel.blocked}
        </Text>
      </Box>
    );
  } else {
    body = (
      <Box flexDirection="column" width={width} borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1} flexShrink={0}>
        {line.text || focused ? <TextRows line={line} room={room - 2} lead="› " cursor={focused} /> : <Text dimColor>{"› "}</Text>}
        {focused
          ? keys([["Enter", sending ? "sending…" : working ? "send (Claude takes it in when it can)" : "send"], ["^J", "new line"], ["Esc", working ? "stop Claude" : "chat"], ["PgUp/Dn", "scroll"]])
          : keys([hint])}
      </Box>
    );
  }
  return (
    <Box ref={box} flexDirection="column" flexShrink={0}>
      {body}
    </Box>
  );
}
