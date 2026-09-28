import stringWidth from "string-width";

const ESC = "\u001b[";
/** Synchronized output (DEC 2026): the terminal shows what lies between these at once. */
const BSU = `${ESC}?2026h`;
const ESU = `${ESC}?2026l`;

/**
 * What Ink writes before a frame: a clear of the whole screen (on Windows at
 * full height, `ansi-escapes` `clearTerminal`, old and new form) or
 * `eraseLines` of the previous frame.
 */
const FRAME_PREFIX = /^(?:\u001b\[2J(?:\u001b\[3J\u001b\[H|\u001b\[0f)|(?:\u001b\[2K(?:\u001b\[1A)?)+\u001b\[G)?/;
/** A control sequence other than a colour (SGR) at the start. */
const CURSOR_START = /^\u001b\[[0-9;?<>=]*[ -/]*[@-ln-~]/;
/** Only escape sequences, no text: mode switches, cursor, queries. */
const CONTROL_ONLY = /^(?:\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_])*$/;

/** The part of a stream the frame buffer needs. */
export interface FrameStream {
  write(chunk: string): unknown;
  columns?: number;
  rows?: number;
  on(event: "resize", listener: () => void): unknown;
}

/**
 * Double buffering between Ink and the terminal. Ink redraws every frame in
 * full: on Windows it clears the whole screen first whenever the output fills
 * the terminal (which the viewer always does), elsewhere it erases the old
 * lines one by one. When the terminal gets that in pieces, e.g. under high
 * CPU load, it shows the empty screen in between: the pane flickers.
 *
 * This keeps the screen last written (`front`) and, for each new frame, writes
 * only the lines that changed, each at its absolute position, with no erase
 * before it, as one write wrapped in synchronized output. Everything that is
 * not a frame passes through unchanged and makes the next frame a full redraw.
 */
export class FrameBuffer {
  /** The lines on the screen; undefined when it is not known (start, resize, other output). */
  private front: string[] | undefined;

  constructor(private out: FrameStream) {
    out.on("resize", () => this.invalidate());
  }

  invalidate(): void {
    this.front = undefined;
  }

  write(text: string): void {
    // Ink's own synchronization around a frame: the frame gets ours.
    if (text === BSU || text === ESU) return;
    const body = text.replace(FRAME_PREFIX, "");
    // Without a known prefix, a frame starts with text or a colour, not with cursor movement.
    const unknown = body === text && CURSOR_START.test(body);
    if (body === "" || unknown || CONTROL_ONLY.test(body)) {
      if (text !== "") this.out.write(text);
      this.invalidate();
      return;
    }
    this.frame(body);
  }

  private frame(body: string): void {
    const rows = this.out.rows || Infinity;
    const columns = this.out.columns || 80;
    const lines = body.split("\n");
    // Ink ends a frame that is shorter than the terminal with a newline.
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    const next = lines.slice(0, rows);
    const full = this.front === undefined;
    const front = this.front ?? [];
    let out = full ? `${ESC}2J` : "";
    next.forEach((line, i) => {
      if (!full && front[i] === line) return;
      // Erasing the rest of a full-width line would take its last character (pending wrap).
      const rest = stringWidth(line) < columns ? `${ESC}0m${ESC}K` : "";
      out += `${ESC}${i + 1};1H${line}${rest}`;
    });
    for (let i = next.length; i < front.length; i++) out += `${ESC}${i + 1};1H${ESC}2K`;
    this.front = next;
    if (out) this.out.write(BSU + out + ESU);
  }
}

/**
 * `stdout` with its writes going through a `FrameBuffer`; everything else
 * (size, resize events, isTTY) is the real stream's, so Ink and the hooks
 * that write to `useStdout()` need no change.
 */
export function frameBufferedStdout(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
  const buffer = new FrameBuffer(stdout);
  const write = (chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
    buffer.write(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") process.nextTick(done as () => void);
    return true;
  };
  return new Proxy(stdout, {
    get(target, key) {
      if (key === "write") return write;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
