import { Text, useInput, usePaste } from "ink";
import stringWidth from "string-width";
import { L } from "../i18n/index.js";
import { editLine, insertable, nextBoundary, toggleFilterIn, type LineState } from "../filter.js";
import type { FilterIn } from "../settings.js";
import { Dialog, type Layout } from "./layout.js";

const MAX_WIDTH = 64;

/**
 * The filter text of a list (Ctrl+F). The list filters while it is typed;
 * Enter keeps the filter, Esc (or Ctrl+F) drops it. ↑↓ and PgUp/PgDn select
 * in the filtered list; every other key edits the text, so no view or app key fires.
 */
export function FilterDialog({
  layout,
  line,
  shown,
  total,
  onChange,
  onKeep,
  onCancel,
  onMove,
  filterIn,
  onFilterIn,
}: {
  layout: Layout;
  line: LineState;
  /** How many entries match, of `total`. */
  shown: number;
  total: number;
  onChange: (line: LineState) => void;
  onKeep: () => void;
  onCancel: () => void;
  /** ↑↓ (±1) and PgUp/PgDn (±page) in the list, as on screen. */
  onMove: (delta: number) => void;
  /** Where the filter looks (the filterIn setting): ^L and ^D switch the list and the details. */
  filterIn: FilterIn;
  onFilterIn: (next: FilterIn) => void;
}) {
  const page = Math.max(1, layout.bodyHeight - 2);
  useInput((input, key) => {
    if (key.return) return onKeep();
    if (key.escape || (key.ctrl && input === "f")) return onCancel();
    if (key.upArrow || key.downArrow) return onMove(key.upArrow ? -1 : 1);
    if (key.pageUp || key.pageDown) return onMove(key.pageUp ? -page : page);
    if (key.ctrl && (input === "l" || input === "d")) return onFilterIn(toggleFilterIn(filterIn, input === "l" ? "list" : "details"));
    const next = editLine(line, input, key);
    if (next !== line) onChange(next);
  });
  // Pasted text arrives as one string (bracketed paste), line breaks included.
  usePaste((text) => onChange(editLine(line, insertable(text), {})));

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  const color = shown === 0 && line.text.trim() ? "red" : "green";
  const box = (on: boolean) => (on ? <Text color="green">[x]</Text> : <Text dimColor>[ ]</Text>);
  // Title, blank, input, count, blank, where, blank, keys, hint, plus the border.
  return (
    <Dialog layout={layout} width={width} height={11}>
      <Text bold color="cyan" wrap="truncate">
        {L().filter.title}
      </Text>
      <Text> </Text>
      <LineField line={line} width={width} />
      <Text color={color} wrap="truncate">
        {"  "}
        {L().filter.count(shown, total)}
      </Text>
      <Text> </Text>
      <Text wrap="truncate">
        {box(filterIn !== "details")} {L().filter.inList} <Text color="yellow">^L</Text>
        {"    "}
        {box(filterIn !== "list")} {L().filter.inDetails} <Text color="yellow">^D</Text>
      </Text>
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="yellow">Enter</Text> {L().dialog.keep}{"  "}
        <Text color="yellow">Esc</Text> {L().dialog.cancel}{"  "}
        <Text color="yellow">↑↓</Text> {L().dialog.select}{"  "}
        <Text color="yellow">^U</Text> {L().dialog.clear}
      </Text>
      <Text dimColor wrap="truncate">
        {L().filter.hint}
      </Text>
    </Dialog>
  );
}

/** A line of text being edited in a dialog `width` columns wide, the part around the cursor shown. */
export function LineField({ line, width }: { line: LineState; width: number }) {
  // Inside the border and padding, one column kept for the cursor at the end.
  const room = width - 4 - 2;
  const { text, cursor, selected } = line;
  let start = 0;
  while (stringWidth(text.slice(start, cursor)) > room) start = nextBoundary(text, start);
  const before = text.slice(start, cursor);
  // The character under the cursor whole: an emoji takes two code units.
  const end = nextBoundary(text, cursor);
  const at = text.slice(cursor, end);
  const after = text.slice(end);
  return (
    <Text wrap="truncate">
      <Text color="yellow">› </Text>
      {selected ? (
        <>
          <Text inverse>{text}</Text>
          <Text inverse> </Text>
        </>
      ) : (
        <>
          {before}
          <Text inverse>{at || " "}</Text>
          {after}
        </>
      )}
    </Text>
  );
}
