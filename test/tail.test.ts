import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileTail } from "../src/transcript/tail.js";

describe("FileTail", () => {
  it("reads existing content and then only appended bytes", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ccmd-")), "t.jsonl");
    writeFileSync(file, "a\n");
    const chunks: string[] = [];
    const tail = new FileTail(file, (c) => chunks.push(c));
    tail.start();
    expect(chunks).toEqual(["a\n"]);
    appendFileSync(file, "b\n");
    await expect.poll(() => chunks, { timeout: 3000 }).toEqual(["a\n", "b\n"]);
    await tail.stop();
  });
});
