import { Text, useInput, usePaste } from "ink";
import { useState } from "react";
import stringWidth from "string-width";
import { editLine, type LineState } from "../filter.js";
import { Dialog, type Layout } from "./layout.js";

const MAX_WIDTH = 72;
/** The rows of text the dialog shows; a longer prompt scrolls with the cursor. */
const TEXT_ROWS = 6;

/** What survives closing the dialog unsent, per session: the next one opens with it. */
const drafts = new Map<string, string>();

/** Text to insert from a paste: line breaks kept (as \n), other control characters as spaces. */
export const pastable = (text: string) => text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ");

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The text cut into rows of at most `room` columns, by line break and by width, each with the offset it starts at,
 * so the cursor can be placed; the cursor's row and column.
 */
export function promptRows(text: string, cursor: number, room: number): { rows: { start: number; text: string }[]; row: number; column: number } {
  const rows: { start: number; text: string }[] = [];
  let start = 0;
  for (const line of text.split("\n")) {
    let rowStart = start;
    let row = "";
    for (const { segment, index } of graphemes.segment(line)) {
      if (stringWidth(row + segment) > room) {
        rows.push({ start: rowStart, text: row });
        rowStart = start + index;
        row = "";
      }
      row += segment;
    }
    rows.push({ start: rowStart, text: row });
    start += line.length + 1;
  }
  // The cursor's row: the last one starting at or before it.
  let row = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i]!.start <= cursor) row = i;
  return { rows, row, column: cursor - rows[row]!.start };
}

/**
 * Asks for a prompt to send to a remote session: several lines, Enter sends, Ctrl+J starts a new line (Shift+Enter
 * does not reach many terminals), Esc closes and keeps the text as the session's draft. Empty text is not sent.
 */
export function PromptDialog({
  layout,
  title,
  lines,
  draftKey,
  onSend,
  onCancel,
  onTyped,
  initialText,
}: {
  layout: Layout;
  title: string;
  /** A few lines about the session, above the text. */
  lines: string[];
  /** The session the draft is kept for. */
  draftKey: string;
  onSend: (text: string) => void;
  onCancel: () => void;
  /** Hears the text as it is typed. */
  onTyped?: (text: string) => void;
  /** Starts with this text instead of the session's draft. */
  initialText?: string;
}) {
  const [line, setLine] = useState<LineState>(() => {
    const text = initialText ?? drafts.get(draftKey) ?? "";
    return { text, cursor: text.length, selected: false };
  });
  const change = (next: LineState) => {
    setLine(next);
    drafts.set(draftKey, next.text);
    onTyped?.(next.text);
  };
  const insert = (text: string) => change({ text: line.text.slice(0, line.cursor) + text + line.text.slice(line.cursor), cursor: line.cursor + text.length, selected: false });
  useInput((input, key) => {
    if (key.escape) return onCancel();
    // Ctrl+J arrives as a line feed, without the return flag.
    if (input === "\n" || (key.ctrl && input === "j")) return insert("\n");
    if (key.return) {
      const text = line.text.trim();
      if (!text) return;
      drafts.delete(draftKey);
      return onSend(text);
    }
    const next = editLine(line, input, key);
    if (next !== line) change(next);
  });
  usePaste((text) => insert(pastable(text)));

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  const room = width - 4 - 3;
  const { rows, row, column } = promptRows(line.text, line.cursor, room);
  const first = Math.max(0, Math.min(row - TEXT_ROWS + 1, rows.length - TEXT_ROWS));
  const shown = Array.from({ length: TEXT_ROWS }, (_, i) => rows[first + i]);
  // Title, blank, the lines, blank, the text, blank, keys, plus the border.
  return (
    <Dialog layout={layout} width={width} height={7 + lines.length + TEXT_ROWS}>
      <Text bold color="cyan" wrap="truncate">
        {title}
      </Text>
      <Text> </Text>
      {lines.map((l, i) => (
        <Text key={i} dimColor wrap="truncate">
          {l}
        </Text>
      ))}
      <Text> </Text>
      {shown.map((r, i) => {
        const at = first + i;
        const lead = <Text color="yellow">{at === 0 ? "› " : "  "}</Text>;
        if (!r) return <Text key={i}> </Text>;
        if (at !== row) return <Text key={i} wrap="truncate">{lead}{r.text}</Text>;
        const before = r.text.slice(0, column);
        const rest = r.text.slice(column);
        const char = [...graphemes.segment(rest)][0]?.segment ?? "";
        return (
          <Text key={i} wrap="truncate">
            {lead}
            {before}
            <Text inverse>{char || " "}</Text>
            {rest.slice(char.length)}
          </Text>
        );
      })}
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="yellow">Enter</Text> send{"  "}
        <Text color="yellow">^J</Text> new line{"  "}
        <Text color="yellow">Esc</Text> close, keep it{"  "}
        <Text color="yellow">^U</Text> clear
      </Text>
    </Dialog>
  );
}
