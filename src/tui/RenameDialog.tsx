import { Text, useInput, usePaste } from "ink";
import { useState } from "react";
import { editLine, insertable, lineOf } from "../filter.js";
import { LineField } from "./FilterDialog.js";
import { Dialog, type Layout } from "./layout.js";

const MAX_WIDTH = 64;

/**
 * Asks for a session's new title, its current one filled in. Enter saves (an empty or unchanged title
 * closes without a change), Esc cancels; every other key edits the text.
 */
export function RenameDialog({
  layout,
  lines,
  title,
  how,
  onSave,
  onCancel,
}: {
  layout: Layout;
  /** The session's head (`sessionHead`). */
  lines: string[];
  /** The name shown for it so far. */
  title: string;
  /** How it is renamed (`renamePlan`), under the head. */
  how?: string;
  onSave: (title: string) => void;
  onCancel: () => void;
}) {
  const [line, setLine] = useState(() => lineOf(title));
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) {
      const name = line.text.trim();
      return !name || name === title ? onCancel() : onSave(name);
    }
    const next = editLine(line, input, key);
    if (next !== line) setLine(next);
  });
  usePaste((text) => setLine(editLine(line, insertable(text), {})));

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Title, blank, the head, blank, input, how, blank, keys, plus the border.
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
      <Text dimColor wrap="truncate">
        {how ? `  ${how}` : " "}
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
