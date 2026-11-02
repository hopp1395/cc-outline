import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { itemTitle, moveItem, newList, progress, readTodos, updateTodos } from "../src/todos.js";
import { inClaudeDir } from "../src/transcript/locate.js";

const dir = mkdtempSync(join(tmpdir(), "cco-todos-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("lists", () => {
  it("title is the first line without emphasis", () => {
    expect(itemTitle("## **Block** `1`\nmehr")).toBe("Block 1");
  });

  it("are kept per project and survive reading", () => {
    inClaudeDir(dir, () => {
      expect(readTodos("/x/y")).toEqual([]);
      const list = newList("Plan", [{ text: "a" }, { text: "b" }], { sessionId: "s1" });
      updateTodos("/x/y", (l) => [...l, list]);
      updateTodos("/x/y", (l) => l.map((x) => ({ ...x, items: x.items.map((i, n) => (n === 0 ? { ...i, status: "done" as const } : i)) })));
      const [read] = readTodos("/x/y");
      expect(read.name).toBe("Plan");
      expect(read.sessionId).toBe("s1");
      expect(progress(read)).toEqual({ done: 1, total: 2 });
      expect(readTodos("/other")).toEqual([]);
    });
  });

  it("moves an item and stops at the ends", () => {
    expect(moveItem([1, 2, 3], 2, -1)).toEqual([1, 3, 2]);
    const same = [1, 2];
    expect(moveItem(same, 0, -1)).toBe(same);
  });
});
