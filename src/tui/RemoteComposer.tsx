import { Box, measureElement, Text, useInput, usePaste, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import { L } from "../i18n/index.js";
import { editLine, type LineState } from "../filter.js";
import { sendInterrupt, sendPrompt, sendResponse } from "../remote/api.js";
import { describeRemoteError } from "../remote/index.js";
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
  { id: "allow", label: "allow" },
  { id: "deny", label: "deny" },
  { id: "reason", label: "reason" },
];

/**
 * The bottom of a remote viewer (setting remoteControl), like Claude Code's: a prompt line that grows with its text
 * (Enter sends, Ctrl+J starts a new line); while Claude waits for an answer, the permission (allow, deny, deny saying
 * why) or the question takes its place. It has the keys while `focused`: Esc (or Tab) hands them to the chat,
 * Esc while Claude works stops it, as in Claude Code. `onHeight` hears the rows it takes, so the chat above leaves them.
 */
export function RemoteComposer({
  layout,
  sessionId,
  title,
  working,
  pending,
  focused,
  onFocus,
  notify,
  onHeight,
}: {
  layout: Layout;
  sessionId: string;
  title: string;
  /** Claude works in the session: a prompt waits until it can, and Esc stops it. */
  working: boolean;
  /** What the worker waits for, the oldest first. */
  pending?: PendingRequest;
  focused: boolean;
  onFocus: (focused: boolean) => void;
  notify: (message: string) => void;
  onHeight: (rows: number) => void;
}) {
  const [line, setLine] = useState<LineState>(EMPTY);
  const [sending, setSending] = useState(false);
  const [choice, setChoice] = useState(0);
  // Deny, saying why: the reason's text, in place of the options.
  const [reason, setReason] = useState<LineState>();
  const [typed, setTyped] = useState("");
  const answered = useRef<string>(undefined);
  const copy = useClipboard();
  const isQuestion = pending?.toolName === "AskUserQuestion" && questionsOf(pending.input).length > 0;

  // A new request starts on Allow; one answered elsewhere drops what was typed for it, into the clipboard.
  const shown = useRef<string>(undefined);
  useEffect(() => {
    const before = shown.current;
    shown.current = pending?.requestId;
    if (before === pending?.requestId) return;
    setChoice(0);
    setReason(undefined);
    if (before && before !== answered.current) {
      const text = typed.trim();
      setTyped("");
      if (text) void copy(text).then(() => notify(L().remote.answeredCopied), () => notify(L().remote.answeredElsewhere));
      else notify(L().remote.answeredElsewhere);
    }
  }, [pending?.requestId]);

  const box = useRef<DOMElement>(null);
  useEffect(() => {
    if (box.current) onHeight(measureElement(box.current).height);
  });

  const report = (done: string) => (p: Promise<void>) => p.then(() => notify(done), (err) => notify(L().remote.notSent(describeRemoteError(err))));
  const answer = (response: Record<string, unknown>, done: string) => {
    if (!pending) return;
    answered.current = pending.requestId;
    setReason(undefined);
    setTyped("");
    void report(done)(sendResponse(sessionId, pending.requestId, response));
  };
  const send = () => {
    const text = line.text.trim();
    if (!text || sending) return;
    setSending(true);
    sendPrompt(sessionId, text).then(
      () => {
        setLine(EMPTY);
        setSending(false);
      },
      (err) => {
        setSending(false);
        notify(L().remote.notSent(describeRemoteError(err)));
      },
    );
  };
  const escape = () => {
    if (working && !pending) return void report(L().remote.interruptSent)(sendInterrupt(sessionId));
    onFocus(false);
  };

  useInput(
    (input, key) => {
      if (key.tab) return onFocus(false);
      if (key.pageUp || key.pageDown) return;
      if (reason) {
        if (key.escape) return setReason(undefined);
        if (input === "\n" || (key.ctrl && input === "j")) return setReason({ ...reason, text: reason.text.slice(0, reason.cursor) + "\n" + reason.text.slice(reason.cursor), cursor: reason.cursor + 1 });
        if (key.return) return reason.text.trim() && answer(permissionResponse(pending!, false, reason.text.trim()), "denied");
        const next = editLine(reason, input, key);
        if (next !== reason) {
          setReason(next);
          setTyped(next.text);
        }
        return;
      }
      if (pending && !isQuestion) {
        if (key.escape) return onFocus(false);
        if (key.upArrow || key.downArrow) return setChoice((c) => (c + (key.upArrow ? -1 : 1) + PERMISSIONS.length) % PERMISSIONS.length);
        const digit = Number(input);
        const pick = key.return ? choice : Number.isInteger(digit) && digit >= 1 && digit <= PERMISSIONS.length ? digit - 1 : -1;
        if (pick < 0) return;
        const id = PERMISSIONS[pick]!.id;
        if (id === "reason") return setReason(EMPTY);
        return answer(permissionResponse(pending, id === "allow"), id === "allow" ? L().remote.allowed : L().remote.denied);
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
      if (!pending) setLine({ text: line.text.slice(0, line.cursor) + add + line.text.slice(line.cursor), cursor: line.cursor + add.length, selected: false });
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
  if (pending && isQuestion) {
    body = (
      <QuestionDialog
        inline
        active={focused}
        layout={layout}
        title={L().remote.asks(truncate(title, 40))}
        questions={questionsOf(pending.input)}
        onSend={(answers) => answer({ behavior: "allow", toolUseID: pending.toolUseId, tool_name: pending.toolName, updatedInput: { ...pending.input, answers } }, L().remote.answerSent)}
        onCancel={() => onFocus(false)}
        onTyped={setTyped}
      />
    );
  } else if (pending) {
    body = (
      <Box flexDirection="column" width={width} borderStyle="round" borderColor="yellow" paddingX={1} flexShrink={0}>
        <Text bold color="yellow" wrap="truncate">
          {L().remote.allowTool(pending.displayName ?? pending.toolName)}
        </Text>
        {toolInputLines(pending, room).map((l, i) => (
          <Text key={i} wrap="truncate">
            {l}
          </Text>
        ))}
        {reason ? (
          <>
            <Text dimColor>{L().remote.why}</Text>
            <TextRows line={reason} room={room - 2} lead="› " />
            {keys([["Enter", L().remote.keys.deny], ["^J", L().remote.keys.newLine], ["Esc", L().remote.keys.back]])}
          </>
        ) : (
          <>
            {PERMISSIONS.map((p, i) => (
              <Text key={p.id} wrap="truncate">
                <Text color="cyan">{i === choice && focused ? "›" : " "}</Text>
                {` ${i + 1}. `}
                <Text bold={i === choice}>{L().remote[p.id as "allow" | "deny" | "reason"]}</Text>
              </Text>
            ))}
            {keys(focused ? [["↑↓", L().remote.keys.choose], ["Enter", L().remote.keys.answer], ["1-3", ""], ["Esc", L().remote.keys.chat]] : [["Tab", L().remote.keys.answerIt]])}
          </>
        )}
      </Box>
    );
  } else {
    body = (
      <Box flexDirection="column" width={width} borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1} flexShrink={0}>
        {line.text || focused ? <TextRows line={line} room={room - 2} lead="› " cursor={focused} /> : <Text dimColor>{"› "}</Text>}
        {focused
          ? keys([["Enter", sending ? L().remote.keys.sending : working ? L().remote.keys.sendWorking : L().remote.keys.send], ["^J", L().remote.keys.newLine], ["Esc", working ? L().remote.keys.stop : L().remote.keys.chat], ["PgUp/Dn", L().remote.keys.scroll]])
          : keys([["Tab", L().remote.keys.write]])}
      </Box>
    );
  }
  return (
    <Box ref={box} flexDirection="column" flexShrink={0}>
      {body}
    </Box>
  );
}
