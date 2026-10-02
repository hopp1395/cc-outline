import { PassThrough } from "node:stream";
import { render } from "ink";
import type { ReactElement } from "react";
import stripAnsi from "strip-ansi";

export const tick = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until `check` holds, at most `tries` ticks; the `expect` after it says what was missing. */
export async function until(check: () => boolean, tries = 150): Promise<void> {
  for (let i = 0; i < tries && !check(); i++) await tick();
}

/**
 * Lets React run the effects of the frame written last. Ink writes a frame when React commits it, and
 * `useInput` subscribes in an effect after that: a key sent at once can reach a dialog that is shown but
 * does not listen yet, or the view behind it.
 */
const settled = () => new Promise<void>((resolve) => setImmediate(() => setTimeout(resolve, 0)));

export interface InkView {
  /** Every frame written that is not blank, with its colours. */
  frames: string[];
  /** The last frame, without colours. */
  frame(): string;
  /** The last frame, with colours. */
  raw(): string;
  /** Everything written, control sequences included. */
  written(): string;
  /** How many frames have been written; a mark for `shown`. */
  count(): number;
  /** Whether a frame since the `from`th showed `text`, for states that pass too fast to poll for. */
  shown(text: string, from?: number): boolean;
  /** Sends keys once the last frame's effects have run. */
  press(keys: string): Promise<void>;
  /** A left click (press and release) at the one-based terminal cell, once the last frame's effects have run. */
  click(column: number, row: number): Promise<void>;
  rerender(element: ReactElement): void;
  unmount(): void;
}

/**
 * Renders `element` into a fake terminal of `size`, as Ink renders the viewer: every write is a whole
 * frame (`debug`). `wrap` puts providers around it, on `rerender` too.
 */
export function renderInk(
  element: ReactElement,
  size: { columns: number; rows: number },
  options: { wrap?: (element: ReactElement) => ReactElement; interactive?: boolean } = {},
): InkView {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: size.columns, rows: size.rows });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, ref: () => {}, unref: () => {} });
  const frames: string[] = [];
  let written = "";
  stdout.on("data", (chunk) => {
    const text = String(chunk);
    written += text;
    if (stripAnsi(text).trim()) frames.push(text);
  });
  const wrap = options.wrap ?? ((e: ReactElement) => e);
  const app = render(wrap(element), {
    stdout: stdout as never,
    stdin: stdin as never,
    debug: true,
    patchConsole: false,
    ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
  });
  const raw = () => frames.at(-1) ?? "";
  return {
    frames,
    frame: () => stripAnsi(raw()),
    raw,
    written: () => written,
    count: () => frames.length,
    shown: (text, from = 0) => frames.slice(from).some((f) => stripAnsi(f).includes(text)),
    press: async (keys) => {
      await settled();
      stdin.write(keys);
    },
    click: async (column, row) => {
      await settled();
      stdin.write(`\u001b[<0;${column};${row}M`);
      stdin.write(`\u001b[<0;${column};${row}m`);
    },
    rerender: (next) => app.rerender(wrap(next)),
    unmount: () => app.unmount(),
  };
}
