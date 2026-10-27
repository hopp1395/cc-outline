import { Box, measureElement, Text, useInput, usePaste, type DOMElement } from "ink";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { editLine, type LineState } from "../filter.js";
import { localRequestLines, type LocalRequest } from "../localRequest.js";
import type { CommandSource } from "../slashCommands.js";
import type { PendingRequest } from "../remote/pending.js";
import { fitUsage, usageParts, usageWidth, type RemoteUsage } from "../remote/usage.js";
import { CommandList, pickerFirst, pickerRows, useCommandPicker } from "./CommandPicker.js";
import { useMouse } from "./mouse.js";
import { pastable, promptRows } from "./PromptDialog.js";
import { QuestionDialog, questionsOf } from "./QuestionDialog.js";
import { truncate, type Layout } from "./layout.js";
import { useClipboard } from "./useClipboard.js";
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

const LEVEL_COLOR = { low: "green", mid: "yellow", high: "red" } as const;

/**
 * The composer's frame: a line above and below, open to the sides so the text has the pane's width. The line below
 * carries `usage` at its right end, like Claude Code's status line: the context of the last answer and the account's
 * windows, `─── Ctx 62k · 5h 23% 2h14m · 7d 97% 3d4h ──`, shortened to fit (`fitUsage`). It reads the clock each
 * minute, so the times left count down.
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
          {parts.map((p, i) => (
            <Text key={p.label}>
              {i > 0 && <Text color="gray">{" · "}</Text>}
              <Text dimColor>{p.label} </Text>
              <Text color={p.level && LEVEL_COLOR[p.level]}>{p.value}</Text>
              {p.rest && <Text dimColor> {p.rest}</Text>}
            </Text>
          ))}{" "}
          {line(2)}
        </Text>
      ) : (
        <Text wrap="truncate">{line(width)}</Text>
      )}
    </Box>
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
  /** Why nothing can be sent now (it runs nowhere, steer remote is off, …); the line shows it in place of the text. */
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
  asked,
  commands,
  usage,
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
   * read-only, since it is answered in its terminal; `where` says how to get there.
   */
  asked?: { request: LocalRequest; where: string };
  /** Where the session's `/` commands come from, for the list a `/` at the prompt's start opens (not while the line is blocked). */
  commands?: CommandSource;
  /** What its frame's bottom line shows at the right (setting usageLine): a remote session's context and the account's windows. */
  usage?: RemoteUsage;
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

  const picker = useCommandPicker(line.text, line.cursor, focused && !channel.blocked && !request ? commands : undefined);

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
  const room = width - 2;
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
  let color = "yellow";
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
    const { request } = asked;
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
        <Text dimColor wrap="truncate">
          {`Answered in its terminal: ${asked.where}`}
        </Text>
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
        {line.text || focused ? <TextRows line={line} room={room - 2} lead="› " cursor={focused} /> : <Text dimColor>{"› "}</Text>}
        {focused && picker.open
          ? keys([["Tab", "take"], ["Enter", "take and send"], ["↑↓", "choose"], ["Esc", "close the list"]])
          : focused
          ? keys([["Enter", sending ? "sending…" : working ? "send (Claude takes it in when it can)" : "send"], ["^J", "new line"], ["Esc", working ? "stop Claude" : "chat"], ["PgUp/Dn", "scroll"]])
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
