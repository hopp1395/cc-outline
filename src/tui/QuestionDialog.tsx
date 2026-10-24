import { Box, Text, useInput, usePaste } from "ink";
import { useState, type ReactNode } from "react";
import stringWidth from "string-width";
import { editLine, insertable, type LineState } from "../filter.js";
import { LineField } from "./FilterDialog.js";
import { bold, Dialog, dim, wrapLines, type Layout } from "./layout.js";

const MAX_WIDTH = 72;

const cyan = (s: string) => `\u001b[36m${s}\u001b[39m`;
const green = (s: string) => `\u001b[32m${s}\u001b[39m`;
const yellow = (s: string) => `\u001b[33m${s}\u001b[39m`;
const inverse = (s: string) => `\u001b[7m${s}\u001b[27m`;

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

/** Whether `a` answers its question: an option checked, or a text typed on "Other…". */
const isAnswered = (a: Answer | undefined) => a !== undefined && (a.picked.length > 0 || Boolean(a.other?.trim()));

/** What `a` says, as the app sends it: the labels (or the typed text), several joined by ", ". */
const answerText = (q: Question, a: Answer) => [...a.picked.map((p) => q.options[p]!.label), ...(a.other?.trim() ? [a.other.trim()] : [])].join(", ");

/**
 * The answers as the app sends them: question → the label (or the typed text); with several checked, joined by
 * ", "; undefined while a question has none.
 */
export function answersOf(questions: Question[], answers: Answer[]): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const [i, q] of questions.entries()) {
    const a = answers[i] ?? { picked: [] };
    if (!isAnswered(a)) return undefined;
    result[q.question] = answerText(q, a);
  }
  return result;
}

/**
 * The tabs of the bar that fit in `room` columns around the `active` one (`from` up to before `to`), each tab
 * `widths[i]` wide and one column apart; while some are left out, two columns per cut side go to its "…".
 */
export function tabWindow(widths: number[], active: number, room: number): { from: number; to: number } {
  const total = widths.reduce((sum, w) => sum + w, 0) + widths.length - 1;
  if (total <= room) return { from: 0, to: widths.length };
  let from = active;
  let to = active + 1;
  let used = widths[active]!;
  const fits = (extra: number, f: number, t: number) => used + extra + (f > 0 ? 2 : 0) + (t < widths.length ? 2 : 0) <= room;
  for (let grew = true; grew; ) {
    grew = false;
    if (to < widths.length && fits(widths[to]! + 1, from, to + 1)) {
      used += widths[to++]! + 1;
      grew = true;
    }
    if (from > 0 && fits(widths[from - 1]! + 1, from - 1, to)) {
      used += widths[--from]! + 1;
      grew = true;
    }
  }
  return { from, to };
}

/** A row of a question: one of its options, or its "Other…" field. */
type Row = { option: number } | { other: true };

/** A line of a question's body; `block` is the row it belongs to (none: the question itself). */
interface BodyLine {
  text: ReactNode;
  block?: number;
}

/**
 * Answers Claude's questions (AskUserQuestion) as Claude Code does: one question at a time, a tab each in a bar
 * above, then a "Submit" tab with the answers. ←→ and Tab switch the tab, ↑↓ pick a row of the question, Enter (or
 * Space, or its digit) chooses an option of a question with one answer and goes on to the next tab; with several,
 * Space checks and Enter goes on. Typing on "Other…" writes the answer. Enter on "Submit" sends once every question
 * has an answer; a single question has no tabs and sends at once. Esc closes without answering.
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
  const tabbed = questions.length > 1;
  // The tabs: one per question, then Submit (only with several).
  const lastTab = tabbed ? questions.length : 0;
  const [tab, setTab] = useState(0);
  const [cursor, setCursor] = useState<number[]>(() => questions.map(() => 0));
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(() => ({ picked: [] })));
  const [field, setField] = useState<LineState[]>(() => questions.map(() => ({ text: "", cursor: 0, selected: false })));
  const [notice, setNotice] = useState<string>();
  const q = tab < questions.length ? tab : undefined;
  const rowsOf = (qi: number): Row[] => [...questions[qi]!.options.map((_, option): Row => ({ option })), { other: true }];
  const row = q === undefined ? undefined : rowsOf(q)[cursor[q]!];

  const go = (t: number) => setTab(Math.max(0, Math.min(lastTab, t)));
  const send = (all: Answer[]) => {
    const result = answersOf(questions, all);
    if (result) return onSend(result);
    setNotice("every question needs an answer");
    go(all.findIndex((a) => !isAnswered(a)));
  };
  // After a choice: the next tab, or with a single question, the answer sent.
  const advance = (all: Answer[]) => (tabbed ? go(tab + 1) : send(all));
  const withAnswer = (qi: number, next: Answer) => {
    const all = answers.map((a, i) => (i === qi ? next : a));
    setAnswers(all);
    return all;
  };
  const choose = (qi: number, option: number) => {
    const question = questions[qi]!;
    const a = answers[qi]!;
    if (!question.multiSelect) return advance(withAnswer(qi, { picked: [option] }));
    const picked = a.picked.includes(option) ? a.picked.filter((p) => p !== option) : [...a.picked, option].sort();
    withAnswer(qi, { ...a, picked });
  };
  const type = (qi: number, next: LineState) => {
    const fields = field.map((f, i) => (i === qi ? next : f));
    setField(fields);
    onTyped?.(fields.map((f) => f.text.trim()).filter(Boolean).join("\n"));
    // Writing an answer checks "Other…"; for one choice only, it takes the place of the options.
    const a = answers[qi]!;
    withAnswer(qi, { picked: questions[qi]!.multiSelect ? a.picked : [], other: next.text });
  };

  useInput((input, key) => {
    setNotice(undefined);
    if (key.escape) return onCancel();
    if (key.tab) return go(tab + (key.shift ? -1 : 1));
    const onOther = row !== undefined && "other" in row;
    // ←→ move the cursor of a typed answer; elsewhere they switch the tab.
    if ((key.leftArrow || key.rightArrow) && !key.ctrl && !key.meta && !(onOther && field[q!]!.text !== "")) return go(tab + (key.leftArrow ? -1 : 1));
    if (q === undefined) return key.return ? send(answers) : undefined;
    if (key.upArrow || key.downArrow) {
      const count = rowsOf(q).length;
      return setCursor((all) => all.map((c, i) => (i === q ? (c + (key.upArrow ? -1 : 1) + count) % count : c)));
    }
    if (!row) return;
    if ("other" in row) {
      if (key.return) return answers[q]!.other?.trim() ? advance(answers) : setNotice("type an answer first");
      const next = editLine(field[q]!, input, key);
      if (next !== field[q]) return type(q, next);
      if (input === " " && field[q]!.text === "") withAnswer(q, { picked: questions[q]!.multiSelect ? answers[q]!.picked : [], other: answers[q]!.other === undefined ? "" : undefined });
      return;
    }
    const digit = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
    if (digit >= 0 && digit < questions[q]!.options.length) {
      setCursor((all) => all.map((c, i) => (i === q ? digit : c)));
      return choose(q, digit);
    }
    if (input === " ") return choose(q, row.option);
    if (key.return) return questions[q]!.multiSelect ? advance(answers) : choose(q, row.option);
  }, { isActive: active });
  usePaste((text) => q !== undefined && row && "other" in row && type(q, editLine(field[q]!, insertable(text), {})));

  const width = inline ? layout.columns : Math.min(MAX_WIDTH, layout.columns - 4);
  // Inside the border and padding.
  const room = width - 4;
  const asked = (question: Question) => (!tabbed && question.header ? `${cyan(question.header)}  ${question.question}` : question.question);

  // The body of a question: its text, then a block of lines per row, the field below "Other…" always kept.
  const questionBody = (qi: number): { head: string[]; rows: BodyLine[]; selected: number } => {
    const question = questions[qi]!;
    const a = answers[qi]!;
    const at = cursor[qi]!;
    const mark = (on: boolean) => {
      const box = question.multiSelect ? (on ? "[x]" : "[ ]") : on ? "(•)" : "( )";
      return on ? green(box) : box;
    };
    const pointer = (i: number) => (i === at ? cyan("›") : " ");
    const digits = String(question.options.length).length;
    const rows: BodyLine[] = [];
    for (const [oi, option] of question.options.entries()) {
      const number = `${String(oi + 1).padStart(digits)}. `;
      const indent = " ".repeat(6 + stringWidth(number));
      const label = oi === at ? bold(option.label) : option.label;
      for (const text of wrapLines(`${pointer(oi)} ${mark(a.picked.includes(oi))} ${number}${label}`, room, indent)) rows.push({ text, block: oi });
      if (option.description) for (const text of wrapLines(option.description, room - indent.length)) rows.push({ text: indent + dim(text), block: oi });
    }
    const other = question.options.length;
    const label = other === at ? bold("Other…") : "Other…";
    rows.push({ text: `${pointer(other)} ${mark(a.other !== undefined)} ${label}`, block: other });
    rows.push({ text: other === at || a.other !== undefined ? <LineField line={field[qi]!} width={width} /> : " ", block: other });
    return { head: [...wrapLines(bold(asked(question)), room), " "], rows, selected: at };
  };
  // The Submit tab: each question with its answer, or that it has none yet.
  const submitBody = (): string[] => [
    bold("Review your answers"),
    ...questions.flatMap((question, qi) => [
      ...wrapLines(`${question.header ? `${cyan(question.header)}  ` : ""}${question.question}`, room),
      ...(isAnswered(answers[qi]) ? wrapLines(green(`→ ${answerText(question, answers[qi]!)}`), room - 2).map((l) => `  ${l}`) : [`  ${yellow("→ no answer yet")}`]),
    ]),
  ];

  // Title, the bar, blank, the body, notice, keys; plus the border. The body is as tall as the tallest tab, so
  // the chat above does not jump, at most what leaves the pane (inline: half of it) room.
  const fixed = 1 + (tabbed ? 1 : 0) + 1 + 1 + 1 + 2;
  const tallest = Math.max(...questions.map((_, qi) => questionBody(qi)).map((b) => b.head.length + b.rows.length), tabbed ? submitBody().length : 0);
  const most = Math.max(4, (inline ? Math.floor(layout.rows / 2) : layout.rows - 2) - fixed);
  const height = Math.min(tallest, most);

  let body: ReactNode[];
  if (q === undefined) body = submitBody().slice(0, height);
  else {
    const { head: fullHead, rows, selected } = questionBody(q);
    const head = fullHead.slice(0, Math.max(1, height - 3));
    const space = height - head.length;
    let shown: ReactNode[] = rows.map((r) => r.text);
    if (rows.length > space) {
      // Too tall: the rows scroll with the selected one, a row above and below saying there is more.
      const inner = Math.max(1, space - 2);
      const first = rows.findIndex((r) => r.block === selected);
      const last = rows.length - 1 - [...rows].reverse().findIndex((r) => r.block === selected);
      let start = last < inner ? 0 : Math.min(last - inner + 1, rows.length - inner);
      if (first < start) start = first;
      shown = [start > 0 ? dim("▲ more") : " ", ...shown.slice(start, start + inner), start + inner < rows.length ? dim("▼ more") : " "];
    }
    body = [...head, ...shown];
  }
  while (body.length < height) body.push(" ");

  const keyItems: [string, string][] =
    q === undefined
      ? [["Enter", "send"]]
      : row && "other" in row
        ? [["↑↓", "row"], ["Enter", tabbed ? "next" : "send"]]
        : questions[q]!.multiSelect
          ? [["↑↓", "row"], ["Space", "check"], ["Enter", tabbed ? "next" : "send"]]
          : [["↑↓", "row"], ["Enter", tabbed ? "choose" : "send"], [questions[q]!.options.length > 1 ? `1-${questions[q]!.options.length}` : "1", ""]];
  if (tabbed) keyItems.push(["←→", "question"]);
  keyItems.push(["Esc", inline ? "chat" : "later"]);

  const content: ReactNode = (
    <>
      <Text bold color="cyan" wrap="truncate">
        {title}
      </Text>
      {tabbed ? <Text wrap="truncate">{tabBar(questions, answers, tab, room)}</Text> : null}
      <Text> </Text>
      {body.map((line, i) => (typeof line === "string" ? <Text key={i} wrap="truncate">{line}</Text> : <Box key={i}>{line}</Box>))}
      <Text color="yellow" wrap="truncate">
        {notice ?? " "}
      </Text>
      <Text wrap="truncate">
        {keyItems.map(([k, what], i) => (
          <Text key={i}>
            <Text color="yellow">{k}</Text>
            {what ? ` ${what}` : ""}
            {"  "}
          </Text>
        ))}
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
  return (
    <Dialog layout={layout} width={width} height={fixed + height}>
      {content}
    </Dialog>
  );
}

/** The bar of tabs: `← ☐ Colour  ☒ Parts  ✔ Submit →`, the active one inverse, cut around it to `room` columns. */
function tabBar(questions: Question[], answers: Answer[], tab: number, room: number): string {
  const labels = [...questions.map((question, qi) => ({ mark: isAnswered(answers[qi]) ? "☒" : "☐", name: question.header || `Question ${qi + 1}` })), { mark: "✔", name: "Submit" }];
  const { from, to } = tabWindow(
    labels.map((l) => stringWidth(` ${l.mark} ${l.name} `)),
    tab,
    // Less the arrows and their spaces.
    room - 4,
  );
  const tabs = labels.slice(from, to).map((l, i) => (from + i === tab ? inverse(bold(` ${l.mark} ${l.name} `)) : ` ${l.mark === "☐" ? l.mark : green(l.mark)} ${l.name} `));
  const arrow = (s: string, on: boolean) => (on ? cyan(s) : dim(s));
  return `${arrow("←", tab > 0)} ${from > 0 ? dim("… ") : ""}${tabs.join(" ")}${to < labels.length ? dim(" …") : ""} ${arrow("→", tab < labels.length - 1)}`;
}
