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
