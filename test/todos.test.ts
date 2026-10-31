import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findBlocks, firstSource, itemTitle, moveItem, newList, progress, readTodos, updateTodos } from "../src/todos.js";
import { inClaudeDir } from "../src/transcript/locate.js";

const dir = mkdtempSync(join(tmpdir(), "cco-todos-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("findBlocks", () => {
  it("takes the points of a numbered list with their sub-points", () => {
    const found = findBlocks("Plan:\n\n1. **Parser** schreiben\n   - Tests dazu\n2. View bauen\n3. Doku\n");
    expect(found.numbered?.map((b) => b.text)).toEqual(["**Parser** schreiben\n- Tests dazu", "View bauen", "Doku"]);
    expect(firstSource(found)).toBe("numbered");
  });

  it("cuts at the deepest heading level used twice", () => {
    const found = findBlocks("# Plan\n\n## Block 1\nA\n\n### Detail\nx\n\n## Block 2\nB\n");
    expect(found.headings?.map((b) => b.text)).toEqual(["Block 1\nA\n\n### Detail\nx", "Block 2\nB"]);
    expect(firstSource(found)).toBe("headings");
  });

  it("cuts at bold label lines, as Claude writes work blocks", () => {
    const found = findBlocks("Sieben Bloecke.\n\n**Block 0: Ausgangslage**\n- Branch anlegen.\n- Bauen.\n\n**Block 1: Resources**\n- Resx anlegen.\n- Meldungen verschieben.\n");
    expect(found.labels?.map((b) => b.text)).toEqual(["Block 0: Ausgangslage\n- Branch anlegen.\n- Bauen.", "Block 1: Resources\n- Resx anlegen.\n- Meldungen verschieben."]);
    // Better than the bullet points inside the blocks.
    expect(firstSource(found)).toBe("labels");
  });

  it("takes the rows of a table as blocks: the number column is left out, the first other column names the block", () => {
    const found = findBlocks(
      "Die Umsetzung läuft in diesen Blöcken:\n\n| # | Block | Inhalt |\n|---|---|---|\n| 1 | ♻️ Modul anlegen | StoredFile zieht nach Datenablage.Domain. |\n| 2 | ♻️ Registrierung | AddDatenablageInfrastructureServices() verbindet den Kontext. |\n| 3 | ♻️ Endpunkte in die Api | DocumentEndpoints ziehen nach src/Api. |\n",
    );
    expect(found.table?.map((b) => b.text)).toEqual([
      "♻️ Modul anlegen\nStoredFile zieht nach Datenablage.Domain.",
      "♻️ Registrierung\nAddDatenablageInfrastructureServices() verbindet den Kontext.",
      "♻️ Endpunkte in die Api\nDocumentEndpoints ziehen nach src/Api.",
    ]);
    expect(firstSource(found)).toBe("table");
  });

  it("falls back to bullets and finds nothing in plain text", () => {
    expect(firstSource(findBlocks("- eins\n- zwei\n"))).toBe("bullets");
    expect(firstSource(findBlocks("Nur ein Satz."))).toBeUndefined();
    expect(firstSource(findBlocks("1. allein"))).toBeUndefined();
  });
});

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
