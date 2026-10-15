import { Text, useInput, usePaste } from "ink";
import stringWidth from "string-width";
import { L } from "../i18n/index.js";
import { useState } from "react";
import { editLine, insertable, lineOf, type LineState } from "../filter.js";
import { Dialog, type Layout } from "./layout.js";

const MAX_WIDTH = 72;

/**
 * Asks for the archive to import, filled with the newest export in the downloads folder (selected,
 * so typing replaces it): Enter imports, Esc cancels. Every other key edits the path.
 */
export function ImportDialog({
  layout,
  initial,
  into,
  onImport,
  onClose,
}: {
  layout: Layout;
  initial: string;
  /** The project folder the sessions go to. */
  into: string;
  onImport: (file: string) => void;
  onClose: () => void;
}) {
  const [line, setLine] = useState<LineState>(() => lineOf(initial));
  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.return) return line.text.trim() && onImport(line.text.trim().replace(/^"(.*)"$/, "$1"));
    const next = editLine(line, input, key);
    if (next !== line) setLine(next);
  });
  usePaste((text) => setLine((l) => editLine(l, insertable(text), {})));

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Inside the border and padding, less the prompt and a column for the cursor at the end.
  const room = width - 4 - 2 - 1;
  const { text, cursor, selected } = line;
  let start = 0;
  while (stringWidth(text.slice(start, cursor)) > room) start++;
  // Title, blank, three lines, blank, input, blank, keys, plus the border.
  return (
    <Dialog layout={layout} width={width} height={11}>
      <Text bold color="cyan" wrap="truncate">
        {L().dialogs.import.title}
      </Text>
      <Text> </Text>
      <Text wrap="truncate">{L().dialogs.import.what}</Text>
      <Text wrap="truncate">{L().dialogs.import.into(into)}</Text>
      <Text dimColor wrap="truncate">
        {L().dialogs.import.skipped}
      </Text>
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="yellow">› </Text>
        {selected ? (
          <>
            <Text inverse>{text.slice(start)}</Text>
            <Text inverse> </Text>
          </>
        ) : (
          <>
            {text.slice(start, cursor)}
            <Text inverse>{text.slice(cursor, cursor + 1) || " "}</Text>
            {text.slice(cursor + 1)}
          </>
        )}
      </Text>
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="yellow">Enter</Text> {L().dialogs.import.import}{"   "}
        <Text color="yellow">Esc</Text> {L().dialog.cancel}{"   "}
        <Text color="yellow">^U</Text> {L().dialog.clear}
      </Text>
    </Dialog>
  );
}
