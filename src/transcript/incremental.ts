import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * A JSONL file read line by line as it grows: each `update` reads only the
 * bytes appended since the last one and hands every complete line to
 * `onLine`. If the file shrank (rewritten), it starts over after `onReset`.
 */
export class IncrementalFile {
  private offset = 0;
  private size = -1;
  private buffer = "";
  private decoder = new TextDecoder("utf-8");

  constructor(
    readonly path: string,
    private readonly onLine: (line: string) => void,
    private readonly onReset?: () => void,
  ) {}

  /** When the file was last written (epoch ms), as of the last `update`; undefined while it cannot be read. */
  modified: number | undefined;

  /** Reads what was appended; returns whether the file changed since the last call. */
  update(): boolean {
    let size: number;
    let modified: number | undefined;
    try {
      const stat = statSync(this.path);
      size = stat.size;
      modified = stat.mtimeMs;
    } catch {
      size = 0;
    }
    if (size < this.offset) this.reset();
    if (size === this.size && modified === this.modified) return false;
    this.size = size;
    this.modified = modified;
    if (size > this.offset) this.read(size);
    return true;
  }

  /** Feeds text directly, as if appended (used by tests). */
  push(text: string): void {
    this.consume(text);
  }

  private reset(): void {
    this.offset = 0;
    this.buffer = "";
    this.decoder = new TextDecoder("utf-8");
    this.onReset?.();
  }

  private read(size: number): void {
    const fd = openSync(this.path, "r");
    try {
      const chunk = Buffer.alloc(Math.min(size - this.offset, 4 * 1024 * 1024));
      while (this.offset < size) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        this.consume(this.decoder.decode(chunk.subarray(0, n), { stream: true }));
      }
    } finally {
      closeSync(fd);
    }
  }

  private consume(text: string): void {
    const lines = (this.buffer + text).split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) this.onLine(line);
  }
}
