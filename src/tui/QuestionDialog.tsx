import { Box, Text, useInput, usePaste } from "ink";
import { useState, type ReactNode } from "react";
import { editLine, insertable, type LineState } from "../filter.js";
import { LineField } from "./FilterDialog.js";
import { Dialog, type Layout } from "./layout.js";

const MAX_WIDTH = 72;

/** One question of an AskUserQuestion call, as Claude asks it. */
export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** The questions of an AskUserQuestion input, those in an unknown shape left out. */
export function questionsOf(input: Record<string, unknown>): Question[] {
  const list = Array.isArray(input.questions) ? input.questions : [];
  return list.flatMap((q): Question[] => {
    if (typeof q !== "object" || q === null || typeof (q as Question).question !== "string") return [];
    const { question, header, multiSelect, options } = q as Question;
    const labels = Array.isArray(options) ? options.filter((o) => typeof o?.label === "string") : [];
    return [{ question, header: typeof header === "string" ? header : undefined, multiSelect: multiSelect === true, options: labels }];
  });
}

/** The choice for one question: the options checked (indexes), and the text of "Other…" when it is checked. */
export interface Answer {
  picked: number[];
  other?: string;
}

/**
 * The answers as the app sends them: question → the label (or the typed text); with several checked, joined by
 * ", "; undefined while a question has none.
 */
export function answersOf(questions: Question[], answers: Answer[]): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const [i, q] of questions.entries()) {
    const a = answers[i] ?? { picked: [] };
    const parts = [...a.picked.map((p) => q.options[p]!.label), ...(a.other?.trim() ? [a.other.trim()] : [])];
    if (parts.length === 0) return undefined;
    result[q.question] = parts.join(", ");
  }
  return result;
}

/** A row of the dialog: an option of a question, or its "Other…" field. */
type Row = { q: number; option: number } | { q: number; other: true };

/**
 * Answers Claude's questions (AskUserQuestion) like the filter dialogs: each question with its options, one (•)
 * or several [x], and "Other…" with a text field. ↑↓ pick a row, Space checks it, typing on "Other…" writes the
 * answer; Enter sends once every question has an answer, Esc closes without answering.
 */
export function QuestionDialog({
  layout,
  title,
  questions,
  onSend,
  onCancel,
  onTyped,
  inline = false,
  active = true,
}: {
  layout: Layout;
  title: string;
  questions: Question[];
  onSend: (answers: Record<string, string>) => void;
  onCancel: () => void;
  /** Hears what is typed into the "Other…" fields, joined: kept if the dialog closes because another app answered. */
  onTyped?: (text: string) => void;
  /** Drawn in place of a remote viewer's prompt line, as wide as the pane, instead of over the view. */
  inline?: boolean;
  /** It takes the keys (the prompt line has the focus). */
  active?: boolean;
}) {
  const rows: Row[] = questions.flatMap((q, i) => [...q.options.map((_, option): Row => ({ q: i, option })), { q: i, other: true } as Row]);
  const [at, setAt] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(() => ({ picked: [] })));
  const [field, setField] = useState<LineState[]>(() => questions.map(() => ({ text: "", cursor: 0, selected: false })));
  const [notice, setNotice] = useState<string>();
  const row = rows[at];

  const setAnswer = (q: number, next: Answer) => setAnswers((all) => all.map((a, i) => (i === q ? next : a)));
  const toggle = (r: Row) => {
    const q = questions[r.q]!;
    const a = answers[r.q]!;
    if ("other" in r) {
      const on = a.other === undefined;
      return setAnswer(r.q, { picked: q.multiSelect ? a.picked : [], other: on ? field[r.q]!.text : undefined });
    }
    if (!q.multiSelect) return setAnswer(r.q, { picked: [r.option] });
    const picked = a.picked.includes(r.option) ? a.picked.filter((p) => p !== r.option) : [...a.picked, r.option].sort();
    setAnswer(r.q, { ...a, picked });
  };
  const type = (r: Row, next: LineState) => {
    const fields = field.map((f, i) => (i === r.q ? next : f));
    setField(fields);
    onTyped?.(fields.map((f) => f.text.trim()).filter(Boolean).join("\n"));
    // Writing an answer checks "Other…"; for one choice only, it takes the place of the options.
    const a = answers[r.q]!;
    setAnswer(r.q, { picked: questions[r.q]!.multiSelect ? a.picked : [], other: next.text });
  };

  useInput((input, key) => {
    setNotice(undefined);
    if (key.escape) return onCancel();
    if (key.return) {
      const result = answersOf(questions, answers);
      return result ? onSend(result) : setNotice("every question needs an answer");
    }
    if (key.upArrow || key.downArrow) return setAt((r) => (r + (key.upArrow ? -1 : 1) + rows.length) % rows.length);
    if (!row) return;
    if ("other" in row) {
      const next = editLine(field[row.q]!, input, key);
      if (next !== field[row.q]) return type(row, next);
      if (input === " " && field[row.q]!.text === "") return toggle(row);
      return;
    }
    if (input === " ") return toggle(row);
  }, { isActive: active });
  usePaste((text) => row && "other" in row && type(row, editLine(field[row.q]!, insertable(text), {})));

  const width = inline ? layout.columns : Math.min(MAX_WIDTH, layout.columns - 4);
  let index = 0;
  const body = questions.flatMap((q, qi) => {
    const a = answers[qi]!;
    const mark = (on: boolean) => (q.multiSelect ? (on ? "[x]" : "[ ]") : on ? "(•)" : "( )");
    const lines = [
      <Text key={`q${qi}`} bold wrap="truncate">
        {q.header ? <Text color="cyan">{`${q.header}  `}</Text> : null}
        {q.question}
      </Text>,
    ];
    for (const [oi, option] of q.options.entries()) {
      const selected = index++ === at;
      lines.push(
        <Text key={`o${qi}-${oi}`} wrap="truncate">
          <Text color="cyan">{selected ? "›" : " "}</Text> <Text color={a.picked.includes(oi) ? "green" : undefined}>{mark(a.picked.includes(oi))}</Text>{" "}
          <Text bold={selected}>{option.label}</Text>
          {option.description ? <Text dimColor>{`  ${option.description}`}</Text> : null}
        </Text>,
      );
    }
    const selected = index++ === at;
    lines.push(
      <Text key={`x${qi}`} wrap="truncate">
        <Text color="cyan">{selected ? "›" : " "}</Text> <Text color={a.other !== undefined ? "green" : undefined}>{mark(a.other !== undefined)}</Text>{" "}
        <Text bold={selected}>Other…</Text>
      </Text>,
    );
    if (selected || a.other !== undefined) lines.push(<LineField key={`f${qi}`} line={field[qi]!} width={width} />);
    lines.push(<Text key={`b${qi}`}> </Text>);
    return lines;
  });
  const content: ReactNode = (
    <>
      <Text bold color="cyan" wrap="truncate">
        {title}
      </Text>
      <Text> </Text>
      {body}
      <Text color="yellow" wrap="truncate">
        {notice ?? " "}
      </Text>
      <Text wrap="truncate">
        <Text color="yellow">↑↓</Text> row{"  "}
        <Text color="yellow">Space</Text> choose{"  "}
        <Text color="yellow">Enter</Text> send{"  "}
        <Text color="yellow">Esc</Text> {inline ? "chat" : "later"}
      </Text>
    </>
  );
  // In place of the prompt line: framed, as tall as it needs.
  if (inline)
    return (
      <Box flexDirection="column" width={width} borderStyle="round" borderColor="yellow" paddingX={1} flexShrink={0}>
        {content}
      </Box>
    );
  // Title, blank, the questions, notice, keys, plus the border.
  return (
    <Dialog layout={layout} width={width} height={2 + body.length + 2 + 2}>
      {content}
    </Dialog>
  );
}
