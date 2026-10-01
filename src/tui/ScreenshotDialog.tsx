import { Text, useInput } from "ink";
import { useState } from "react";
import { imageAction } from "../transcript/chrome.js";
import type { Screenshot } from "../transcript/parse.js";
import { Dialog, type Layout } from "./layout.js";

const MAX_WIDTH = 72;

/**
 * Lists the screenshots of a turn (number, action, page) to open one in the
 * image viewer. Starts on the last; ↑↓ choose, Enter opens and keeps the
 * dialog open, Esc (or O) closes. Takes all keys while open.
 */
export function ScreenshotDialog({
  layout,
  shots,
  onOpen,
  onClose,
}: {
  layout: Layout;
  shots: Screenshot[];
  onOpen: (shot: Screenshot) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(shots.length - 1);
  useInput((input, key) => {
    if (key.escape || input === "O") return onClose();
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSelected((s) => Math.min(shots.length - 1, s + 1));
    if (key.home) return setSelected(0);
    if (key.end) return setSelected(shots.length - 1);
    if (key.return && shots[selected]) onOpen(shots[selected]);
  });

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Title, blank, the rows, blank, keys, plus the border.
  const rows = Math.max(1, Math.min(shots.length, layout.rows - 10));
  const first = Math.max(0, Math.min(selected - Math.floor(rows / 2), shots.length - rows));
  const digits = String(shots.length).length;
  return (
    <Dialog layout={layout} width={width} height={rows + 6}>
      <Text bold color="cyan" wrap="truncate">
        Screenshots of this turn · {shots.length}
      </Text>
      <Text> </Text>
      {shots.slice(first, first + rows).map((s, i) => {
        const at = first + i === selected;
        const image = s.block.outcome?.images?.[s.index];
        return (
          <Text key={s.n} wrap="truncate" inverse={at}>
            {at ? "▶ " : "  "}
            <Text color="cyan">{String(s.n).padStart(digits)}</Text> {imageAction(s.block.name, s.block.input, image).padEnd(16)}
            <Text dimColor={!at}>{s.block.outcome?.page ?? ""}</Text>
          </Text>
        );
      })}
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="yellow">↑↓</Text> choose{"   "}
        <Text color="yellow">↵</Text> open{"   "}
        <Text color="yellow">Esc</Text> close
      </Text>
    </Dialog>
  );
}
