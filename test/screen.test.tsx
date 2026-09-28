import { PassThrough } from "node:stream";
import { Text, render } from "ink";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { Screen, type Layout } from "../src/tui/layout.js";
import { VERSION } from "../src/version.js";

async function topBar(columns: number, status: string): Promise<string> {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows: 10 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  // With debug, every write is a whole frame; the version appears in the one after the first layout.
  let output = "";
  stdout.on("data", (chunk) => {
    const frame = stripAnsi(String(chunk));
    if (frame) output = frame;
  });
  const layout: Layout = { columns, rows: 10, listWidth: 20, previewWidth: columns - 23, bodyHeight: 8 };
  const app = render(
    <Screen layout={layout} mode="chat" status={<Text>{status}</Text>} list={null} preview={null} footer="" />,
    { stdout: stdout as never, stdin: stdin as never, debug: true, patchConsole: false, interactive: true },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  app.unmount();
  return output.split("\n")[0]!;
}

describe("Screen top bar", () => {
  it("shows the version on the right when there is room", async () => {
    const line = await topBar(160, "3 prompts");
    expect(line).toContain("3 prompts");
    expect(line.trimEnd().endsWith(`v${VERSION}`)).toBe(true);
    expect(line.length).toBeLessThanOrEqual(160);
  });

  it("leaves the version out rather than cutting the status", async () => {
    const tabs = "cco  1 Chat  2 Changes  3 Plan  4 Sessions  5 Monitor  6 Settings  ".length;
    const status = "x".repeat(160 - tabs - 3);
    const line = await topBar(160, status);
    expect(line).toContain(status);
    expect(line).not.toContain(`v${VERSION}`);
  });

  it("shows the version again once the status is short enough", async () => {
    const tabs = "cco  1 Chat  2 Changes  3 Plan  4 Sessions  5 Monitor  6 Settings  ".length;
    const status = "x".repeat(160 - tabs - ` v${VERSION} `.length);
    expect(await topBar(160, status)).toContain(`${status} v${VERSION}`);
  });

  it("still truncates a bar that is too wide", async () => {
    expect(await topBar(60, "3 prompts")).toBe("cco  1 Chat  2 Changes  3 Plan  4 Sessions  5 Monitor  6 Se…");
  });
});
