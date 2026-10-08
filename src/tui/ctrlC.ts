/**
 * Ctrl+C never reaches Ink. Windows Terminal copies with Ctrl+C only while it
 * has a selection of its own; with mouse reporting on, a drag selects in the
 * viewer instead, so a Ctrl+C after it arrives as `\x03`. Ink would quit on it
 * (`exitOnCtrlC`) or, without that, hand every `useInput` a `c` with `ctrl`,
 * which the views' `c` bindings take for themselves. `withoutCtrlC` takes it
 * out of what Ink reads and tells the `onCtrlC` listeners (`App`: copy the
 * preview's selection again, else say that `q` quits).
 */

const listeners = new Set<() => void>();

/** Calls `listener` on every Ctrl+C; returns the unsubscribe. */
export function onCtrlC(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells the listeners of a Ctrl+C (the stdin filter, and tests). */
export function emitCtrlC(): void {
  for (const listener of [...listeners]) listener();
}

const CTRL_C = 0x03;

/** `chunk` without its Ctrl+C characters, and how many there were. */
export function stripCtrlC(chunk: string | Buffer): { chunk: string | Buffer; count: number } {
  if (typeof chunk === "string") {
    const rest = chunk.replaceAll("\x03", "");
    return { chunk: rest, count: chunk.length - rest.length };
  }
  if (!chunk.includes(CTRL_C)) return { chunk, count: 0 };
  const rest = Buffer.from(chunk.filter((b) => b !== CTRL_C));
  return { chunk: rest, count: chunk.length - rest.length };
}

/** `stdin` for Ink: its `read()` drops Ctrl+C and calls `emitCtrlC` for each. */
export function withoutCtrlC(stdin: NodeJS.ReadStream): NodeJS.ReadStream {
  return new Proxy(stdin, {
    get(target, prop) {
      if (prop === "read")
        return (size?: number) => {
          const chunk = target.read(size) as string | Buffer | null;
          if (chunk === null) return null;
          const stripped = stripCtrlC(chunk);
          for (let i = 0; i < stripped.count; i++) emitCtrlC();
          return stripped.chunk;
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
