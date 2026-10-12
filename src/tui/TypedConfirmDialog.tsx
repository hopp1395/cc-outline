import { Text, useInput, usePaste } from "ink";
import { useState } from "react";
import { editLine, insertable, lineOf } from "../filter.js";
import { LineField } from "./FilterDialog.js";
import { Dialog, type Layout } from "./layout.js";

/** The second confirmation of something that is hard to undo: the user types `word` to go on. */
export interface TypedConfirmation {
  title: string;
  /** A few lines of detail below the title. */
  lines: string[];
  /** What must be typed, e.g. the account's folder name. */
  word: string;
  onConfirm: () => void;
}

const MAX_WIDTH = 64;

/**
 * Asks to type a word before something that can't be undone easily (the danger zone): Enter goes on only when
 * the text is `word`, Esc cancels; every other key edits the text. Red, like a dangerous confirmation.
 */
export function TypedConfirmDialog({ layout, confirmation, onClose }: { layout: Layout; confirmation: TypedConfirmation; onClose: () => void }) {
  const [line, setLine] = useState(() => lineOf(""));
  const [wrong, setWrong] = useState(false);
  const change = (next: typeof line) => {
    setLine(next);
    setWrong(false);
  };
  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.return) {
      if (line.text.trim() !== confirmation.word) return setWrong(true);
      onClose();
      return confirmation.onConfirm();
    }
    const next = editLine(line, input, key);
    if (next !== line) change(next);
  });
  usePaste((text) => change(editLine(line, insertable(text), {})));

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Title, blank, lines, blank, the prompt, input, error, blank, keys, plus the border.
  return (
    <Dialog layout={layout} width={width} height={10 + confirmation.lines.length} borderColor="red">
      <Text bold color="red" wrap="truncate">
        {confirmation.title}
      </Text>
      <Text> </Text>
      {confirmation.lines.map((l, i) => (
        <Text key={i} wrap="truncate">
          {l}
        </Text>
      ))}
      <Text> </Text>
      <Text wrap="truncate">
        Type <Text color="red" bold>{confirmation.word}</Text> to confirm:
      </Text>
      <LineField line={line} width={width} />
      <Text color="red" wrap="truncate">
        {wrong ? `  That is not ${confirmation.word}` : " "}
      </Text>
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="red">Enter</Text> confirm{"  "}
        <Text color="yellow">Esc</Text> cancel{"  "}
        <Text color="yellow">^U</Text> clear
      </Text>
    </Dialog>
  );
}
