import { Text, useInput } from "ink";
import { useState } from "react";
import type { AttachmentItem } from "../attachments.js";
import { Dialog, type Layout } from "./layout.js";

const MAX_WIDTH = 72;

/** "14:32", local time. */
function time(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The symbol and colour of an item: pasted images magenta, tool images and PDFs cyan, @-mentions yellow. */
const SYMBOL: Record<AttachmentItem["kind"], [string, string]> = {
  pasted: ["⎘", "magenta"],
  file: ["@", "yellow"],
  directory: ["@", "yellow"],
  image: ["▣", "cyan"],
  pdf: ["▤", "cyan"],
};

/** The number shown after the symbol: `#n` for pasted images, `n` for tool images and PDFs, none for @-mentions. */
const numberOf = (item: AttachmentItem) => (item.kind === "pasted" ? `#${item.n}` : item.kind === "image" || item.kind === "pdf" ? String(item.n) : "");

/** What the row names: the image, the file read or the browser action, the path. */
function nameOf(item: AttachmentItem): string {
  switch (item.kind) {
    case "pasted":
      return item.prompt ? `pasted image · ${item.prompt}` : "pasted image";
    case "file":
    case "directory": {
      const path = item.path.replace(/\\/g, "/");
      return (item.kind === "directory" ? path.replace(/\/?$/, "/") : path) + (item.uuids && item.uuids.length > 1 ? ` (${item.uuids.length}×)` : "");
    }
    default:
      return item.label;
  }
}

/**
 * Lists what came with a turn (`of` "turn") or a whole session: pasted
 * images, @-mentioned files and folders, the images and PDFs of tool results,
 * to open one in its default app. Starts on the last; ↑↓ choose, Enter opens
 * and keeps the dialog open, Esc (or o) closes. Takes all keys while open.
 */
export function AttachmentsDialog({
  layout,
  items,
  of = "turn",
  onOpen,
  onClose,
}: {
  layout: Layout;
  items: AttachmentItem[];
  of?: "turn" | "session";
  onOpen: (item: AttachmentItem) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(items.length - 1);
  useInput((input, key) => {
    if (key.escape || input === "o") return onClose();
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSelected((s) => Math.min(items.length - 1, s + 1));
    if (key.home) return setSelected(0);
    if (key.end) return setSelected(items.length - 1);
    if (key.return && items[selected]) onOpen(items[selected]);
  });

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Title, blank, the rows, blank, keys, plus the border.
  const rows = Math.max(1, Math.min(items.length, layout.rows - 10));
  const first = Math.max(0, Math.min(selected - Math.floor(rows / 2), items.length - rows));
  const digits = Math.max(0, ...items.map((i) => numberOf(i).length));
  return (
    <Dialog layout={layout} width={width} height={rows + 6}>
      <Text bold color="cyan" wrap="truncate">
        Attachments of this {of} · {items.length}
      </Text>
      <Text> </Text>
      {items.slice(first, first + rows).map((item, i) => {
        const at = first + i === selected;
        const [symbol, color] = SYMBOL[item.kind];
        const page = item.kind === "image" || item.kind === "pdf" ? item.page : undefined;
        return (
          <Text key={first + i} wrap="truncate" inverse={at}>
            {at ? "▶ " : "  "}
            <Text color={color}>
              {symbol} {numberOf(item).padStart(digits)}
            </Text>{" "}
            {of === "session" && item.at ? <Text dimColor={!at}>{time(item.at)} </Text> : null}
            {nameOf(item).padEnd(16)}
            {page ? <Text dimColor={!at}> {page}</Text> : null}
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
