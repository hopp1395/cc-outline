import { closeSync, openSync, readSync, statSync } from "node:fs";
import { watch, type FSWatcher } from "chokidar";

/**
 * Follows a growing file and reports newly appended text. Reads from the last
 * byte offset, so each change costs only the appended bytes.
 */
export class FileTail {
  private offset = 0;
  private watcher?: FSWatcher;
  private decoder = new TextDecoder("utf-8");

  constructor(
    readonly path: string,
    private onData: (chunk: string) => void,
  ) {}

  start(): void {
    this.read();
    this.watcher = watch(this.path, {
      awaitWriteFinish: false,
      // Windows fs events can be missed for files held open by another process.
      usePolling: process.platform === "win32",
      interval: 250,
    });
    this.watcher.on("add", () => this.read());
    this.watcher.on("change", () => this.read());
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  private read(): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size < this.offset) this.offset = 0; // truncated or replaced
    if (size === this.offset) return;
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.alloc(size - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      // stream: true keeps multi-byte chars split across reads intact
      const text = this.decoder.decode(buf.subarray(0, n), { stream: true });
      if (text) this.onData(text);
    } finally {
      closeSync(fd);
    }
  }
}

/** Calls back whenever a small file (e.g. the hook's active-session file) changes. */
export function watchFile(path: string, onChange: () => void): FSWatcher {
  const w = watch(path, { usePolling: process.platform === "win32", interval: 500 });
  w.on("add", onChange);
  w.on("change", onChange);
  return w;
}
