import { PassThrough } from "node:stream";
import chalk from "chalk";
import { render, Text } from "ink";
import stripAnsi from "strip-ansi";
import { expect, it } from "vitest";
import { AreaContext, List } from "../src/tui/layout.js";

it("draws the selection across the list's width, also past a short entry", async () => {
  // With colours: Ink drops trailing spaces, but not those inside the selection's style.
  const level = chalk.level;
  chalk.level = 1;
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 60, rows: 10 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  stdout.on("data", (chunk) => {
    if (String(chunk).trim()) frame = stripAnsi(String(chunk));
  });
  const items = ["short", "an entry far longer than the thirty columns of the list"];
  const list = (selected: number) => (
    <AreaContext.Provider value={{ x: 0, y: 0, width: 30, height: 5 }}>
      <List items={items} selected={selected} height={5} empty="–" itemKey={(s) => s} render={(s) => <Text>{s}</Text>} />
    </AreaContext.Provider>
  );
  const app = render(list(0), { stdout: stdout as never, stdin: stdin as never, debug: true, patchConsole: false });
  await new Promise((r) => setTimeout(r, 50));
  expect(frame.split("\n")[0]).toBe("short".padEnd(30));
  app.rerender(list(1));
  await new Promise((r) => setTimeout(r, 50));
  const [first, second] = frame.split("\n");
  expect(first).toBe("short");
  expect(second).toHaveLength(30);
  expect(second.endsWith("…")).toBe(true);
  app.unmount();
  chalk.level = level;
});

it("keeps its window while the selection moves through the middle, and the selected entry's row when entries are added", async () => {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 40, rows: 12 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  stdout.on("data", (chunk) => {
    if (String(chunk).trim()) frame = stripAnsi(String(chunk));
  });
  const make = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `item ${from + i}`);
  const list = (items: string[], selected: number) => (
    <AreaContext.Provider value={{ x: 0, y: 0, width: 30, height: 9 }}>
      <List items={items} selected={selected} height={9} empty="–" itemKey={(s) => s} render={(s) => <Text>{s}</Text>} />
    </AreaContext.Provider>
  );
  const rowOf = (text: string) => frame.split("\n").findIndex((l) => l.trim() === text);
  const items = make(30);
  const app = render(list(items, 0), { stdout: stdout as never, stdin: stdin as never, debug: true, patchConsole: false });
  const show = async (all: string[], selected: number) => {
    app.rerender(list(all, selected));
    await new Promise((r) => setTimeout(r, 20));
  };
  for (let i = 1; i <= 10; i++) await show(items, i);
  // Held on the lower third's first row since item 6.
  expect(rowOf("item 10")).toBe(6);
  await show(items, 7);
  // Back up through the middle: the window has not moved.
  expect(rowOf("item 7")).toBe(3);
  expect(rowOf("item 10")).toBe(6);
  // Two entries arrive above: item 7 stays on its row.
  await show([...make(2, 100), ...items], 9);
  expect(rowOf("item 7")).toBe(3);
  app.unmount();
});
