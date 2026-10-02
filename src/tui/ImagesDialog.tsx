import { Text, useInput } from "ink";
import { useState } from "react";
import { imageAction } from "../transcript/chrome.js";
import type { Screenshot } from "../transcript/parse.js";
import { Dialog, type Layout } from "./layout.js";

const MAX_WIDTH = 72;

/** An entry of the dialog: an image pasted into the prompt (`index` from 0) or a screenshot of a browser action. */
export type TurnImage = { kind: "pasted"; index: number } | { kind: "shot"; shot: Screenshot };

/** The pasted images of a turn's prompt, then its screenshots. */
export const turnImages = (pasted: number, shots: Screenshot[]): TurnImage[] => [
  ...Array.from({ length: pasted }, (_, index) => ({ kind: "pasted" as const, index })),
  ...shots.map((shot) => ({ kind: "shot" as const, shot })),
];

/**
 * Lists the images of a turn (the prompt's pasted ones, then the screenshots
 * with number, action and page) to open one in the image viewer. Starts on
 * the last; ↑↓ choose, Enter opens and keeps the dialog open, Esc (or o)
 * closes. Takes all keys while open.
 */
export function ImagesDialog({
  layout,
  images,
  onOpen,
  onClose,
}: {
  layout: Layout;
  images: TurnImage[];
  onOpen: (image: TurnImage) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(images.length - 1);
  useInput((input, key) => {
    if (key.escape || input === "o") return onClose();
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSelected((s) => Math.min(images.length - 1, s + 1));
    if (key.home) return setSelected(0);
    if (key.end) return setSelected(images.length - 1);
    if (key.return && images[selected]) onOpen(images[selected]);
  });

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Title, blank, the rows, blank, keys, plus the border.
  const rows = Math.max(1, Math.min(images.length, layout.rows - 10));
  const first = Math.max(0, Math.min(selected - Math.floor(rows / 2), images.length - rows));
  const digits = String(images.length).length;
  return (
    <Dialog layout={layout} width={width} height={rows + 6}>
      <Text bold color="cyan" wrap="truncate">
        Images of this turn · {images.length}
      </Text>
      <Text> </Text>
      {images.slice(first, first + rows).map((image, i) => {
        const at = first + i === selected;
        const lead = at ? "▶ " : "  ";
        if (image.kind === "pasted")
          return (
            <Text key={`pasted-${image.index}`} wrap="truncate" inverse={at}>
              {lead}
              <Text color="magenta">⎘ {String(image.index + 1).padStart(digits)}</Text> {"pasted image".padEnd(16)}
            </Text>
          );
        const s = image.shot;
        const shown = s.block.outcome?.images?.[s.index];
        return (
          <Text key={`shot-${s.n}`} wrap="truncate" inverse={at}>
            {lead}
            <Text color="cyan">▣ {String(s.n).padStart(digits)}</Text> {imageAction(s.block.name, s.block.input, shown).padEnd(16)}
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
