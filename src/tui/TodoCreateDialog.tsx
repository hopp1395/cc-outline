import { Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { askBlocks, BLOCKS_MODEL, rememberedBlocks } from "../todoBlocks.js";
import { itemTitle, type Block } from "../todos.js";
import { Dialog, truncate, type Layout } from "./layout.js";

const MAX_WIDTH = 76;

const MODEL_NAME = BLOCKS_MODEL[0]!.toUpperCase() + BLOCKS_MODEL.slice(1);

type Run = { state: "running" } | { state: "failed"; message: string } | { state: "done"; blocks: Block[] };

/**
 * Has Claude find the work blocks of an answer, then makes a to-do list of them (`src/todoBlocks.ts`): Esc stops the
 * run. Afterwards ↑↓ move, Space leaves a block out or takes it in, Enter makes the list of the blocks taken, r asks
 * again, Esc cancels. Takes all keys while open.
 */
export function TodoCreateDialog({
  layout,
  markdown: shownAnswer,
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
  // The answer as it was when the dialog opened: one still being written must not start a run per line.
  const [markdown] = useState(shownAnswer);
  // A new value starts a run, past what was found before; 0 takes that if there is any.
  const [asked, setAsked] = useState(0);
  const [run, setRun] = useState<Run>(() => {
    const known = rememberedBlocks(markdown);
    return known ? { state: "done", blocks: known } : { state: "running" };
  });
  const [seconds, setSeconds] = useState(0);
  const [left, setLeft] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState(0);
  const blocks = run.state === "done" ? run.blocks : [];
  const taken = blocks.filter((_, i) => !left.has(i));

  useEffect(() => {
    if (asked === 0 && rememberedBlocks(markdown)) return;
    setRun({ state: "running" });
    setSeconds(0);
    setLeft(new Set());
    setSelected(0);
    const started = askBlocks(markdown);
    let current = true;
    started.result.then(
      (found) => current && setRun({ state: "done", blocks: found }),
      (err: Error) => current && setRun({ state: "failed", message: err.message }),
    );
    const clock = setInterval(() => setSeconds((s) => s + 1), 1000);
    void started.result.catch(() => {}).finally(() => clearInterval(clock));
    return () => {
      current = false;
      clearInterval(clock);
      started.cancel();
    };
  }, [asked, markdown]);

  useInput((input, key) => {
    if (key.escape) return onClose();
    if (run.state === "running") return;
    if (input === "r") return setAsked((a) => a + 1);
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
    if (key.return && taken.length) {
      onClose();
      onCreate(name, taken);
    }
  });

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  const rows = Math.max(1, Math.min(blocks.length || 1, layout.rows - 10));
  const first = Math.max(0, Math.min(selected - Math.floor(rows / 2), blocks.length - rows));
  const help = run.state === "running" ? "Esc stop" : blocks.length ? "↑↓ move · Space leave out · ↵ create · r ask again · Esc cancel" : "r ask again · Esc close";
  // Title, blank, the rows, blank, keys, plus the border.
  return (
    <Dialog layout={layout} width={width} height={rows + 6}>
      <Text bold color="cyan" wrap="truncate">
        {blocks.length ? `To-do list · ${taken.length} of ${blocks.length}` : "To-do list"}
      </Text>
      <Text> </Text>
      {run.state === "running" ? (
        <Text dimColor wrap="truncate">
          Claude ({MODEL_NAME}) reads the answer… {seconds} s
        </Text>
      ) : run.state === "failed" ? (
        <Text color="red" wrap="truncate">
          ✗ {run.message}
        </Text>
      ) : blocks.length === 0 ? (
        <Text dimColor wrap="truncate">
          Claude found no work blocks in this answer.
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
        {help}
      </Text>
    </Dialog>
  );
}
