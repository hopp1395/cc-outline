import { Text, useInput, usePaste } from "ink";
import stringWidth from "string-width";
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
  onImport,
  onClose,
}: {
  layout: Layout;
  initial: string;
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
  // Title, blank, two lines, blank, input, blank, keys, plus the border.
  return (
    <Dialog layout={layout} width={width} height={10}>
      <Text bold color="cyan" wrap="truncate">
        Import sessions
      </Text>
      <Text> </Text>
      <Text wrap="truncate">The backups in a cco-session-export zip archive.</Text>
      <Text dimColor wrap="truncate">
        Sessions that are there already are skipped.
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
        <Text color="yellow">Enter</Text> import{"   "}
        <Text color="yellow">Esc</Text> cancel{"   "}
        <Text color="yellow">^U</Text> clear
      </Text>
    </Dialog>
  );
}
