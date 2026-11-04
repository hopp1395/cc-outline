import { Box, Text, useInput, usePaste } from "ink";
import { useState, type ReactNode } from "react";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import { editLine, insertable, type LineState } from "../filter.js";
import { usesPreviews } from "../switchSession.js";
import { LineField } from "./FilterDialog.js";
import { bold, Dialog, dim, wrapLines, type Layout } from "./layout.js";

const MAX_WIDTH = 72;

const cyan = (s: string) => `\u001b[36m${s}\u001b[39m`;
const green = (s: string) => `\u001b[32m${s}\u001b[39m`;
const yellow = (s: string) => `\u001b[33m${s}\u001b[39m`;
const inverse = (s: string) => `\u001b[7m${s}\u001b[27m`;

/** One question of an AskUserQuestion call, as Claude asks it; an option's `preview` is shown beside the options. */
export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
}

/** The questions of an AskUserQuestion input, those in an unknown shape left out. */
export function questionsOf(input: Record<string, unknown>): Question[] {
  const list = Array.isArray(input.questions) ? input.questions : [];
  return list.flatMap((q): Question[] => {
    if (typeof q !== "object" || q === null || typeof (q as Question).question !== "string") return [];
    const { question, header, multiSelect, options } = q as Question;
    const labelled = Array.isArray(options) ? options.filter((o) => typeof o?.label === "string") : [];
    const kept = labelled.map(({ label, description, preview }) => ({
      label,
      ...(typeof description === "string" && { description }),
      ...(typeof preview === "string" && { preview }),
    }));
    return [{ question, header: typeof header === "string" ? header : undefined, multiSelect: multiSelect === true, options: kept }];
  });
}

/** What Claude Code answers for a question with previews that got a note but no option. */
export const NOTES_ONLY = "(notes only)";

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
    // In the preview layout a typed text is a note without an option.
    result[q.question] = usesPreviews(q) && a.picked.length === 0 ? NOTES_ONLY : answerText(q, a);
  }
  return result;
}

/**
 * What Claude Code adds for the questions with previews: the chosen option's preview, or the note typed in place
 * of an option; undefined when there is nothing to add.
 */
export function annotationsOf(questions: Question[], answers: Answer[]): Record<string, { preview?: string; notes?: string }> | undefined {
  const result: Record<string, { preview?: string; notes?: string }> = {};
  for (const [i, q] of questions.entries()) {
    const a = answers[i];
    if (!usesPreviews(q) || !a) continue;
    const preview = a.picked.length ? q.options[a.picked[0]!]?.preview : undefined;
    const notes = a.picked.length ? undefined : a.other?.trim();
    if (preview || notes) result[q.question] = { ...(preview && { preview }), ...(notes && { notes }) };
  }
  return Object.keys(result).length ? result : undefined;
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

/** From this many columns on, a preview stands beside the options (as in Claude Code); below them in narrower ones. */
const PREVIEW_BESIDE = 100;

/**
 * An option's preview in a box `width` columns wide, its text as written (not Markdown), lines too wide cut and at
 * most `rows` rows, the rest named in its last line; without one, that there is none.
 */
export function previewBox(preview: string | undefined, width: number, rows = Infinity): string[] {
  if (!preview?.trim()) return [dim("No preview available")];
  let lines = preview.replace(/\t/g, "  ").replace(/\s+$/, "").split(/\r?\n/);
  const room = Math.max(1, rows - 2);
  if (lines.length > room) {
    const left = lines.length - room + 1;
    lines = [...lines.slice(0, room - 1), dim(`… ${left} more line${left === 1 ? "" : "s"}`)];
  }
  // As wide as its widest line, at most `width`.
  const inner = Math.max(1, Math.min(width - 4, Math.max(...lines.map((l) => stringWidth(l)))));
  const fit = (line: string) => {
    const cut = stringWidth(line) > inner ? sliceAnsi(line, 0, inner) : line;
    return cut + " ".repeat(Math.max(0, inner - stringWidth(cut)));
  };
  const edge = dim("─".repeat(inner + 2));
  return [dim("┌") + edge + dim("┐"), ...lines.map((l) => `${dim("│")} ${fit(l)} ${dim("│")}`), dim("└") + edge + dim("┘")];
}

/** The rows a question's previews take at most, box included (its tallest preview, uncut). */
const previewHeight = (q: Question, width: number) => (usesPreviews(q) ? Math.max(...q.options.map((o) => previewBox(o.preview, width).length)) : 0);

/** `rows` cut to `space` lines around the `selected` row, a line above and below saying there is more. */
function scrolled(rows: BodyLine[], selected: number, space: number): ReactNode[] {
  if (rows.length <= space) return rows.map((r) => r.text);
  const inner = Math.max(1, space - 2);
  const first = rows.findIndex((r) => r.block === selected);
  const last = rows.length - 1 - [...rows].reverse().findIndex((r) => r.block === selected);
  let start = last < inner ? 0 : Math.min(last - inner + 1, rows.length - inner);
  if (first < start) start = first;
  return [start > 0 ? dim("▲ more") : " ", ...rows.slice(start, start + inner).map((r) => r.text), start + inner < rows.length ? dim("▼ more") : " "];
}

/**
 * Answers Claude's questions (AskUserQuestion) as Claude Code does: one question at a time, a tab each in a bar
 * above, then a "Submit" tab with the answers. ←→ and Tab switch the tab, ↑↓ pick a row of the question, Enter (or
 * Space, or its digit) chooses an option of a question with one answer and goes on to the next tab; with several,
 * Space checks and Enter goes on. Typing on "Other…" writes the answer. Enter on "Submit" sends once every question
 * has an answer; a single question has no tabs and sends at once. Esc closes without answering. A question with
 * previews (`usesPreviews`) shows the selected option's preview beside the options (below them in a narrow pane),
 * its "Other…" is a note without an option ("Note only…"), as in Claude Code; the dialog is as tall as its tallest
 * preview needs, up to three quarters of the pane.
 */
export function QuestionDialog({
  layout,
  title,
  questions,
  onSend,
  onCancel,
  onLeave,
  onTyped,
  inline = false,
  active = true,
}: {
  layout: Layout;
  title: string;
  questions: Question[];
  /** The answers as the app sends them, and the choices they come from (for typing them into Claude Code's dialog). */
  onSend: (answers: Record<string, string>, picks: Answer[]) => void;
  /** Esc: closes it, or where `onLeave` is given, cancels the question as Esc in Claude Code does. */
  onCancel: () => void;
  /** Tab: hands the keys back without answering (`←→` still switch the question); without it Tab switches the question. */
  onLeave?: () => void;
  /** Hears what is typed into the "Other…" fields, joined: kept if the dialog closes because another app answered. */
  onTyped?: (text: string) => void;
  /** Drawn in place of a remote viewer's prompt line, as wide as the pane and in its frame, instead of over the view. */
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
    if (result) return onSend(result, all);
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
    if (key.tab && onLeave) return onLeave();
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
  // Inside the border and padding (inline: the prompt line's frame, open to the sides).
  const room = inline ? width : width - 4;
  const asked = (question: Question) => (!tabbed && question.header ? `${cyan(question.header)}  ${question.question}` : question.question);

  // A question with previews: the options in `cols` columns, the preview beside them in the rest (or below, in all).
  const beside = room >= PREVIEW_BESIDE;
  const optionCols = (question: Question) => (usesPreviews(question) && beside ? Math.min(60, Math.floor((room - 2) / 2)) : room);
  const previewCols = (question: Question) => (beside ? room - optionCols(question) - 2 : room);

  // The body of a question: its text, then a block of lines per row, the field below "Other…" always kept.
  const questionBody = (qi: number): { head: string[]; rows: BodyLine[]; selected: number } => {
    const question = questions[qi]!;
    const cols = optionCols(question);
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
      for (const text of wrapLines(`${pointer(oi)} ${mark(a.picked.includes(oi))} ${number}${label}`, cols, indent)) rows.push({ text, block: oi });
      if (option.description) for (const text of wrapLines(option.description, cols - indent.length)) rows.push({ text: indent + dim(text), block: oi });
    }
    const other = question.options.length;
    const name = usesPreviews(question) ? "Note only…" : "Other…";
    const label = other === at ? bold(name) : name;
    rows.push({ text: `${pointer(other)} ${mark(a.other !== undefined)} ${label}`, block: other });
    // The field's own width counts its border and padding (`LineField`): four columns more than its text.
    rows.push({ text: other === at || a.other !== undefined ? <LineField line={field[qi]!} width={cols + 4} /> : " ", block: other });
    return { head: [...wrapLines(bold(asked(question)), room), " "], rows, selected: at };
  };
  // The rows a question takes: its text and options, and beside or below them its tallest preview.
  const questionHeight = (qi: number) => {
    const { head, rows } = questionBody(qi);
    const question = questions[qi]!;
    const preview = previewHeight(question, previewCols(question));
    if (!preview) return head.length + rows.length;
    return head.length + (beside ? Math.max(rows.length, preview) : rows.length + 1 + preview);
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
  // the chat above does not jump, at most what leaves the pane (inline: half of it, three quarters with previews) room.
  const fixed = 1 + (tabbed ? 1 : 0) + 1 + 1 + 1 + 2;
  const tallest = Math.max(...questions.map((_, qi) => questionHeight(qi)), tabbed ? submitBody().length : 0);
  const share = questions.some(usesPreviews) ? 3 / 4 : 1 / 2;
  const most = Math.max(4, (inline ? Math.floor(layout.rows * share) : layout.rows - 2) - fixed);
  const height = Math.min(tallest, most);

  let body: ReactNode[];
  if (q === undefined) body = submitBody().slice(0, height);
  else {
    const question = questions[q]!;
    const { head: fullHead, rows, selected } = questionBody(q);
    const head = fullHead.slice(0, Math.max(1, height - 3));
    const space = height - head.length;
    // The selected option's preview; none on "Note only…".
    const preview = (rowsLeft: number) => (row && "option" in row ? previewBox(question.options[row.option]!.preview, previewCols(question), rowsLeft) : []);
    if (!usesPreviews(question)) body = [...head, ...scrolled(rows, selected, space)];
    else if (beside) {
      // Too tall: the rows scroll with the selected one; the preview is cut.
      const left = scrolled(rows, selected, space);
      const right = preview(space);
      const cols = optionCols(question);
      const lines = Array.from({ length: Math.min(space, Math.max(left.length, right.length)) }, (_, i) => (
        <Box key={i}>
          <Box width={cols} flexShrink={0}>
            {typeof left[i] === "string" || left[i] === undefined ? <Text wrap="truncate">{left[i] ?? " "}</Text> : left[i]}
          </Box>
          <Text wrap="truncate">{`  ${right[i] ?? ""}`}</Text>
        </Box>
      ));
      body = [...head, ...lines];
    } else {
      // Below the options: they keep a few rows, the preview gets the rest.
      const wanted = previewHeight(question, previewCols(question));
      const optionRows = Math.min(rows.length, space, Math.max(Math.min(rows.length, 4), space - 1 - wanted));
      const left = space - optionRows - 1;
      body = [...head, ...scrolled(rows, selected, optionRows), ...(left >= 3 ? [" ", ...preview(left)] : [])];
    }
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
  if (onLeave) keyItems.push(["Esc", "cancel the question"], ["Tab", "chat"]);
  else keyItems.push(["Esc", inline ? "chat" : "later"]);

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
  // In place of the prompt line, as tall as it needs: the prompt line's frame holds it.
  if (inline) return content;
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
