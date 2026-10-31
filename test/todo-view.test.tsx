import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { newList, readTodos, updateTodos } from "../src/todos.js";
import type { Layout } from "../src/tui/layout.js";
import { TodoView } from "../src/tui/TodoView.js";

const layout: Layout = { columns: 120, rows: 24, listWidth: 40, previewWidth: 77, bodyHeight: 20 };
const cwd = join(tmpdir(), "cco-todo-view-project");
const dirs: string[] = [];

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "cco-todo-view-"));
  dirs.push(dir);
  process.env.CLAUDE_CONFIG_DIR = dir;
  updateTodos(cwd, () => [newList("Umbau", [{ text: "Parser schreiben" }, { text: "View bauen\n- mit Tests" }, { text: "Doku" }])]);
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const statuses = () => readTodos(cwd)[0]!.items.map((i) => i.status);

function show(props: Partial<Parameters<typeof TodoView>[0]> = {}) {
  const sent: string[] = [];
  const view = renderInk(<TodoView cwd={cwd} layout={layout} active busy={false} send={async (t) => (sent.push(t), "sent")} {...props} />, layout);
  return { view, sent };
}

describe("TodoView", () => {
  it("lists the project's lists with their progress and shows the items after Enter", async () => {
    const { view } = show();
    await expect.poll(view.frame).toContain("Umbau");
    await expect.poll(view.frame).toContain("0/3");
    await view.press("\r");
    await expect.poll(view.frame).toContain("Parser schreiben");
    await expect.poll(view.frame).toContain("Doku");
    view.unmount();
  });

  it("shows the selected item in grey, closed, until the items have the keys, then as a list's selection, open", async () => {
    const { view } = show();
    await expect.poll(view.frame).toContain("Parser schreiben");
    // The lists have the keys: the last selected item is quiet grey and its text stays closed.
    expect(view.raw()).toContain("\u001b[48;2;58;61;65m");
    expect(view.raw()).not.toContain("\u001b[7m\u001b[1m○ 1. Parser schreiben");
    await view.press("\r");
    await expect.poll(view.raw).toContain("\u001b[7m\u001b[1m○ 1. Parser schreiben");
    view.unmount();
  });

  it("ticks an item off with Space and back with o", async () => {
    const { view } = show();
    await view.press("\r");
    await view.press(" ");
    await expect.poll(statuses).toEqual(["done", "open", "open"]);
    await expect.poll(view.frame).toContain("1/3 done");
    await view.press("o");
    await expect.poll(statuses).toEqual(["open", "open", "open"]);
    view.unmount();
  });

  it("sends the selected item's text and marks it as sent", async () => {
    const { view, sent } = show();
    await view.press("\r");
    await view.press("\u001b[B");
    await view.press("\r");
    await expect.poll(() => sent).toEqual(["View bauen\n- mit Tests"]);
    await expect.poll(statuses).toEqual(["open", "doing", "open"]);
    view.unmount();
  });

  it("asks before sending while Claude works, and sends nothing when blocked", async () => {
    const busy = show({ busy: true });
    await busy.view.press("\r");
    await busy.view.press("\r");
    await expect.poll(busy.view.frame).toContain("Claude is still working");
    expect(busy.sent).toEqual([]);
    await busy.view.press("\r");
    await expect.poll(() => busy.sent).toEqual(["Parser schreiben"]);
    busy.view.unmount();

    const blocked = show({ blocked: "no Claude Code" });
    await blocked.view.press("\r");
    await blocked.view.press("\r");
    await expect.poll(blocked.view.frame).toContain("no Claude Code");
    expect(blocked.sent).toEqual([]);
    blocked.view.unmount();
  });

  it("moves an item down with J and deletes a list after asking", async () => {
    const { view } = show();
    await view.press("\r");
    await view.press("J");
    await expect.poll(() => readTodos(cwd)[0]!.items.map((i) => i.text)).toEqual(["View bauen\n- mit Tests", "Parser schreiben", "Doku"]);
    await view.press("\u001b");
    await expect.poll(view.frame).toContain("── ↵ items");
    await view.press("d");
    await expect.poll(view.frame).toContain("Delete the list");
    await view.press("\r");
    await expect.poll(() => readTodos(cwd)).toEqual([]);
    view.unmount();
  });
});
