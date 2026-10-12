import { Text, useInput, usePaste } from "ink";
import { useState } from "react";
import { editLine, insertable, lineOf } from "../filter.js";
import { LineField } from "./FilterDialog.js";
import { Dialog, type Layout } from "./layout.js";

const MAX_WIDTH = 64;

/**
 * Asks for a session's new title, its current one filled in. Enter saves (an empty title is refused,
 * an unchanged one closes), Esc cancels; every other key edits the text.
 */
export function RenameDialog({
  layout,
  lines,
  title,
  onSave,
  onCancel,
}: {
  layout: Layout;
  /** The session's head (`sessionHead`). */
  lines: string[];
  /** Its /rename title so far. */
  title: string;
  onSave: (title: string) => void;
  onCancel: () => void;
}) {
  const [line, setLine] = useState(() => lineOf(title));
  const [empty, setEmpty] = useState(false);
  const change = (next: typeof line) => {
    setLine(next);
    setEmpty(false);
  };
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) {
      const name = line.text.trim();
      if (!name) return setEmpty(true);
      return name === title ? onCancel() : onSave(name);
    }
    const next = editLine(line, input, key);
    if (next !== line) change(next);
  });
  usePaste((text) => change(editLine(line, insertable(text), {})));

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Title, blank, the head, blank, input, error, blank, keys, plus the border.
  return (
    <Dialog layout={layout} width={width} height={9 + lines.length}>
      <Text bold color="cyan" wrap="truncate">
        Rename the session
      </Text>
      <Text> </Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor wrap="truncate">
          {line}
        </Text>
      ))}
      <Text> </Text>
      <LineField line={line} width={width} />
      <Text color="red" wrap="truncate">
        {empty ? "  The name must not be empty" : " "}
      </Text>
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="yellow">Enter</Text> save{"  "}
        <Text color="yellow">Esc</Text> cancel{"  "}
        <Text color="yellow">^U</Text> clear
      </Text>
    </Dialog>
  );
}
