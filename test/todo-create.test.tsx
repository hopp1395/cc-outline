import { Box } from "ink";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { claudeOutput, fakeSpawn } from "./helpers/fakeClaude.js";
import { proc } from "../src/proc.js";
import { TIMING } from "../src/timing.js";
import { forgetBlocks } from "../src/todoBlocks.js";
import type { Block } from "../src/todos.js";
import type { Layout } from "../src/tui/layout.js";
import { TodoCreateDialog } from "../src/tui/TodoCreateDialog.js";

const layout: Layout = { columns: 100, rows: 24, listWidth: 30, previewWidth: 67, bodyHeight: 20 };
const threeBlocks = claudeOutput([{ title: "Parser" }, { title: "View" }, { title: "Doku" }]);

const realSpawn = proc.spawn;
const realTimeout = TIMING.todoBlocks;
afterAll(() => {
  proc.spawn = realSpawn;
  TIMING.todoBlocks = realTimeout;
  forgetBlocks();
});

let fake: ReturnType<typeof fakeSpawn>;
beforeEach(() => {
  fake = fakeSpawn();
  proc.spawn = fake.spawn as unknown as typeof proc.spawn;
  forgetBlocks();
  // Long enough that a run only ends when the test ends it.
  TIMING.todoBlocks = 60_000;
});

function show() {
  const made: { name: string; blocks: Block[] }[] = [];
  let closed = 0;
  const view = renderInk(
    <Box width={layout.columns} height={layout.rows}>
      <TodoCreateDialog layout={layout} markdown="Plan" name="Umbau" onCreate={(name, blocks) => made.push({ name, blocks })} onClose={() => closed++} />
    </Box>,
    layout,
  );
  return { view, made, closed: () => closed };
}

describe("TodoCreateDialog", () => {
  it("says that Claude reads, then makes a list of the blocks, without those left out", async () => {
    const { view, made } = show();
    await expect.poll(view.frame).toContain("Claude (Haiku) reads the answer");
    await view.press("\r");
    expect(made).toEqual([]);
    fake.runs[0]!.finish(threeBlocks);
    await expect.poll(view.frame).toContain("3 of 3");
    await view.press(" ");
    await expect.poll(view.frame).toContain("2 of 3");
    await view.press("\r");
    await expect.poll(() => made.length).toBe(1);
    expect(made[0]!.name).toBe("Umbau");
    expect(made[0]!.blocks.map((b) => b.text)).toEqual(["View", "Doku"]);
    view.unmount();
  });

  it("Esc stops the run", async () => {
    const { view, closed } = show();
    await expect.poll(() => fake.runs.length).toBe(1);
    await view.press("\u001b");
    await expect.poll(closed).toBe(1);
    view.unmount();
    expect(fake.runs[0]!.killed).toBe(true);
  });

  it("says so when the answer has no blocks and creates nothing", async () => {
    const { view, made } = show();
    await expect.poll(() => fake.runs.length).toBe(1);
    fake.runs[0]!.finish(claudeOutput([]));
    await expect.poll(view.frame).toContain("found no work blocks");
    await view.press("\r");
    expect(made).toEqual([]);
    view.unmount();
  });

  it("shows a failure, and r asks again", async () => {
    const { view } = show();
    await expect.poll(() => fake.runs.length).toBe(1);
    fake.runs[0]!.finish("Not logged in");
    await expect.poll(view.frame).toContain("✗ Not logged in");
    await view.press("r");
    await expect.poll(() => fake.runs.length).toBe(2);
    await expect.poll(view.frame).toContain("reads the answer");
    fake.runs[1]!.finish(threeBlocks);
    await expect.poll(view.frame).toContain("3 of 3");
    view.unmount();
  });

  it("opened again on the same answer it starts no run, until r", async () => {
    const first = show();
    await expect.poll(() => fake.runs.length).toBe(1);
    fake.runs[0]!.finish(threeBlocks);
    await expect.poll(first.view.frame).toContain("3 of 3");
    first.view.unmount();

    const second = show();
    await expect.poll(second.view.frame).toContain("3 of 3");
    expect(fake.runs.length).toBe(1);
    await second.view.press("r");
    await expect.poll(() => fake.runs.length).toBe(2);
    second.view.unmount();
  });

  it("the run that r replaces no longer counts", async () => {
    const { view } = show();
    await expect.poll(() => fake.runs.length).toBe(1);
    fake.runs[0]!.finish("Not logged in");
    await expect.poll(view.frame).toContain("✗");
    await view.press("r");
    await expect.poll(() => fake.runs.length).toBe(2);
    view.unmount();
    expect(fake.runs[1]!.killed).toBe(true);
  });
});
