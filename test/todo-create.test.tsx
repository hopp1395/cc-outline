import { Box } from "ink";
import { describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import type { Block } from "../src/todos.js";
import type { Layout } from "../src/tui/layout.js";
import { TodoCreateDialog } from "../src/tui/TodoCreateDialog.js";

const layout: Layout = { columns: 100, rows: 24, listWidth: 30, previewWidth: 67, bodyHeight: 20 };
const answer = "Plan:\n\n1. Parser\n2. View\n3. Doku\n\n## A\nx\n\n## B\ny\n";

function show(markdown = answer) {
  const made: { name: string; blocks: Block[] }[] = [];
  const view = renderInk(
    <Box width={layout.columns} height={layout.rows}>
      <TodoCreateDialog layout={layout} markdown={markdown} name="Umbau" onCreate={(name, blocks) => made.push({ name, blocks })} onClose={() => {}} />
    </Box>,
    layout,
  );
  return { view, made };
}

describe("TodoCreateDialog", () => {
  it("makes a list of the numbered points, without those left out", async () => {
    const { view, made } = show();
    await expect.poll(view.frame).toContain("numbered points · 3 of 3");
    await view.press(" ");
    await expect.poll(view.frame).toContain("2 of 3");
    await view.press("\r");
    await expect.poll(() => made.length).toBe(1);
    expect(made[0]!.name).toBe("Umbau");
    expect(made[0]!.blocks.map((b) => b.text)).toEqual(["View", "Doku"]);
    view.unmount();
  });

  it("takes the other cut with s", async () => {
    const { view, made } = show();
    await expect.poll(view.frame).toContain("numbered points");
    await view.press("s");
    await expect.poll(view.frame).toContain("headings · 2 of 2");
    await view.press("\r");
    await expect.poll(() => made[0]?.blocks.map((b) => b.text)).toEqual(["A\nx", "B\ny"]);
    view.unmount();
  });

  it("says so when the answer has no blocks and creates nothing", async () => {
    const { view, made } = show("Nur ein Satz.");
    await expect.poll(view.frame).toContain("No numbered points");
    await view.press("\r");
    expect(made).toEqual([]);
    view.unmount();
  });
});
