import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { onCtrlC, stripCtrlC, withoutCtrlC } from "../src/tui/ctrlC.js";

it("takes Ctrl+C out of strings and buffers", () => {
  expect(stripCtrlC("a\x03b\x03")).toEqual({ chunk: "ab", count: 2 });
  expect(stripCtrlC("plain")).toEqual({ chunk: "plain", count: 0 });
  const { chunk, count } = stripCtrlC(Buffer.from([0x61, 0x03, 0x62]));
  expect(Buffer.isBuffer(chunk) && chunk.toString()).toBe("ab");
  expect(count).toBe(1);
});

it("reads stdin without Ctrl+C and tells the listeners", () => {
  const raw = new PassThrough();
  const stdin = withoutCtrlC(raw as unknown as NodeJS.ReadStream);
  let heard = 0;
  const stop = onCtrlC(() => heard++);
  raw.write("q\x03");
  expect(String(stdin.read())).toBe("q");
  expect(heard).toBe(1);
  expect(stdin.read()).toBeNull();
  stop();
  raw.write("\x03");
  stdin.read();
  expect(heard).toBe(1);
  // Everything else is the stream's own.
  expect(stdin.readable).toBe(true);
});
