import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { continuedInOf, predecessors, startsWithCompact } from "../src/transcript/continuation.js";

const line = (entry: object) => JSON.stringify(entry) + "\n";
const title = line({ type: "custom-title", customTitle: "orders" });
const boundary = line({ type: "system", subtype: "compact_boundary", uuid: "b", content: "Conversation compacted" });
const prompt = (uuid: string) => line({ type: "user", uuid, message: { role: "user", content: "go" } });
const continued = (id: string) => line({ type: "continued-in", continuedInSessionId: id });

describe("continued sessions", () => {
  it("finds the transcripts a session continued from, oldest first", () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-chain-"));
    const file = (id: string) => join(dir, `${id}.jsonl`);
    writeFileSync(file("a"), prompt("1") + continued("b") + line({ type: "cost-state" }));
    writeFileSync(file("b"), title + boundary + prompt("2") + continued("c"));
    writeFileSync(file("c"), title + boundary + prompt("3"));
    writeFileSync(file("other"), prompt("4"));
    expect(continuedInOf(file("a"))).toBe("b");
    expect(continuedInOf(file("c"))).toBeUndefined();
    expect(startsWithCompact(file("c"))).toBe(true);
    expect(startsWithCompact(file("a"))).toBe(false);
    expect(predecessors(file("c"))).toEqual([file("a"), file("b")]);
    // Starting after a compact is not enough: no transcript names it.
    expect(predecessors(file("a"))).toEqual([]);
    writeFileSync(file("d"), boundary + prompt("5"));
    expect(predecessors(file("d"))).toEqual([]);
  });

  it("notices a continued-in entry written later", () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-chain-"));
    const a = join(dir, "a.jsonl");
    writeFileSync(a, prompt("1"));
    expect(continuedInOf(a)).toBeUndefined();
    appendFileSync(a, continued("b"));
    expect(continuedInOf(a)).toBe("b");
  });
});
