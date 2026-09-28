import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createElement } from "react";
import { Text, render } from "ink";
import { describe, expect, it } from "vitest";
import { FrameBuffer, frameBufferedStdout } from "../src/tui/frameBuffer.js";
import { Screen, type Layout } from "../src/tui/layout.js";

const ESC = "\u001b[";
const BSU = `${ESC}?2026h`;
const ESU = `${ESC}?2026l`;
// What Ink writes before a frame (ansi-escapes clearTerminal / eraseLines(3)).
const CLEAR = `${ESC}2J${ESC}3J${ESC}H`;
const ERASE_3 = `${ESC}2K${ESC}1A${ESC}2K${ESC}1A${ESC}2K${ESC}G`;

function fakeStream(columns = 10, rows = 5) {
  const writes: string[] = [];
  const stream = Object.assign(new EventEmitter(), { columns, rows, write: (s: string) => writes.push(s) });
  return { stream, writes, buffer: new FrameBuffer(stream) };
}

describe("FrameBuffer", () => {
  it("draws the first frame in full, in one synchronized write", () => {
    const { buffer, writes } = fakeStream();
    buffer.write(`${CLEAR}one\ntwo`);
    expect(writes).toEqual([`${BSU}${ESC}2J${ESC}3J${ESC}1;1Hone${ESC}0m${ESC}K${ESC}2;1Htwo${ESC}0m${ESC}K${ESU}`]);
  });

  it("then writes only the lines that changed, and nothing for the same frame", () => {
    const { buffer, writes } = fakeStream();
    buffer.write(`${CLEAR}one\ntwo\nthree`);
    buffer.write(`${CLEAR}one\n2\nthree`);
    expect(writes[1]).toBe(`${BSU}${ESC}2;1H2${ESC}0m${ESC}K${ESU}`);
    buffer.write(`${ERASE_3}one\n2\nthree`);
    expect(writes).toHaveLength(2);
  });

  it("erases the lines a shorter frame leaves", () => {
    const { buffer, writes } = fakeStream();
    buffer.write("a\nb\nc\n");
    buffer.write(`${ERASE_3}a\n`);
    expect(writes[1]).toBe(`${BSU}${ESC}2;1H${ESC}2K${ESC}3;1H${ESC}2K${ESU}`);
  });

  it("does not erase after a full-width line, and cuts frames taller than the terminal", () => {
    const { buffer, writes } = fakeStream(4, 2);
    buffer.write("abcd\nx\ny");
    expect(writes[0]).toBe(`${BSU}${ESC}2J${ESC}3J${ESC}1;1Habcd${ESC}2;1Hx${ESC}0m${ESC}K${ESU}`);
  });

  it("swallows Ink's own synchronization and passes other output through", () => {
    const { buffer, writes } = fakeStream();
    buffer.write("a");
    buffer.write(BSU);
    buffer.write(ESU);
    buffer.write(`${ESC}?1004h`);
    buffer.write(`${ESC}?25l`);
    // Text after an unknown cursor movement is not taken for a frame.
    buffer.write(`${ESC}5Aconsole output\n`);
    expect(writes.slice(1)).toEqual([`${ESC}?1004h`, `${ESC}?25l`, `${ESC}5Aconsole output\n`]);
    // After output it does not know the effect of, the next frame is drawn in full.
    buffer.write("a");
    expect(writes[4]).toContain(`${ESC}2J`);
  });

  it("passes the window title through without redrawing the next frame", () => {
    const { buffer, writes } = fakeStream();
    buffer.write(`${CLEAR}one\ntwo`);
    buffer.write("\u001b]0;◐ orders\u0007");
    buffer.write(`${CLEAR}one\n2`);
    expect(writes.slice(1)).toEqual(["\u001b]0;◐ orders\u0007", `${BSU}${ESC}2;1H2${ESC}0m${ESC}K${ESU}`]);
  });

  it("draws in full again after a resize", () => {
    const { buffer, stream, writes } = fakeStream();
    buffer.write("a");
    buffer.write("a");
    expect(writes).toHaveLength(1);
    stream.emit("resize");
    buffer.write("a");
    expect(writes).toHaveLength(2);
  });
});

describe("frameBufferedStdout with Ink", () => {
  it("updates a changed line without clearing the screen", async () => {
    const columns = 100;
    const real = Object.assign(new PassThrough(), { isTTY: true, columns, rows: 6 });
    const writes: string[] = [];
    real.on("data", (chunk) => writes.push(String(chunk)));
    const stdout = frameBufferedStdout(real as unknown as NodeJS.WriteStream);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const layout: Layout = { columns, rows: 6, listWidth: 20, previewWidth: columns - 23, bodyHeight: 4 };
    const frame = (status: string) =>
      createElement(Screen, { layout, mode: "chat", status: createElement(Text, null, status), list: null, preview: null, footer: "" });
    const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
    const app = render(frame("first"), { stdout, stdin: stdin as never, patchConsole: false, interactive: true });
    await wait();
    const before = writes.length;
    app.rerender(frame("second"));
    await wait();
    app.unmount();
    const update = writes.slice(before).find((w) => w.includes("second"));
    expect(update).toBeDefined();
    expect(update).not.toContain(`${ESC}2J`);
    // Only the top bar changed.
    expect(update!.match(/\u001b\[\d+;1H/g)).toEqual([`${ESC}1;1H`]);
  });
});
