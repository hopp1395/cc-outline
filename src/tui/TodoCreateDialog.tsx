import { Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { BLOCK_SOURCES, findBlocks, firstSource, itemTitle, type Block, type BlockSource } from "../todos.js";
import { Dialog, truncate, type Layout } from "./layout.js";

const MAX_WIDTH = 76;

const SOURCE_LABEL: Record<BlockSource, string> = { numbered: "numbered points", headings: "headings", labels: "bold labels", bullets: "bullet points" };

/**
 * Cuts an answer into blocks for a to-do list: the numbered points, else the headings, else the bold label lines, else the bullet points
 * (`s` takes the next way, if the answer has one). ↑↓ move, Space leaves a block out or takes it in, Enter makes
 * the list of the blocks taken, Esc cancels. Takes all keys while open.
 */
export function TodoCreateDialog({
  layout,
  markdown,
  name,
  onCreate,
  onClose,
}: {
  layout: Layout;
  /** Claude's answer. */
  markdown: string;
  /** The list's name. */
  name: string;
  onCreate: (name: string, blocks: Block[]) => void;
  onClose: () => void;
}) {
  const found = useMemo(() => findBlocks(markdown), [markdown]);
  const sources = BLOCK_SOURCES.filter((s) => found[s]?.length);
  const [source, setSource] = useState<BlockSource | undefined>(() => firstSource(found));
  const blocks = source ? (found[source] ?? []) : [];
  const [left, setLeft] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState(0);
  const taken = blocks.filter((_, i) => !left.has(i));

  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSelected((s) => Math.min(blocks.length - 1, s + 1));
    if (key.home) return setSelected(0);
    if (key.end) return setSelected(Math.max(0, blocks.length - 1));
    if (input === " " && blocks.length) {
      return setLeft((l) => {
        const next = new Set(l);
        if (!next.delete(selected)) next.add(selected);
        return next;
      });
    }
    if (input === "s" && sources.length > 1 && source) {
      setSource(sources[(sources.indexOf(source) + 1) % sources.length]);
      setLeft(new Set());
      return setSelected(0);
    }
    if (key.return && taken.length) {
      onClose();
      onCreate(name, taken);
    }
  });

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  const rows = Math.max(1, Math.min(blocks.length || 1, layout.rows - 10));
  const first = Math.max(0, Math.min(selected - Math.floor(rows / 2), blocks.length - rows));
  // Title, blank, the rows, blank, keys, plus the border.
  return (
    <Dialog layout={layout} width={width} height={rows + 6}>
      <Text bold color="cyan" wrap="truncate">
        {source ? `To-do list from ${SOURCE_LABEL[source]} · ${taken.length} of ${blocks.length}` : "To-do list"}
      </Text>
      <Text> </Text>
      {blocks.length === 0 ? (
        <Text dimColor wrap="truncate">
          No numbered points, headings or bullet points (two at least) in this answer.
        </Text>
      ) : (
        blocks.slice(first, first + rows).map((b, n) => {
          const i = first + n;
          const on = !left.has(i);
          return (
            <Text key={i} inverse={i === selected} dimColor={!on && i !== selected} wrap="truncate">
              {on ? "[x] " : "[ ] "}
              {truncate(itemTitle(b.text), width - 8)}
            </Text>
          );
        })
      )}
      <Text> </Text>
      <Text dimColor wrap="truncate">
        ↑↓ move · Space leave out{sources.length > 1 ? " · s other cut" : ""} · ↵ create · Esc cancel
      </Text>
    </Dialog>
  );
}
