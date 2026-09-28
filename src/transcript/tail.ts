import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { watch, type FSWatcher } from "chokidar";

/**
 * Follows a growing file and reports newly appended text. Reads from the last
 * byte offset, so each change costs only the appended bytes.
 */
export class FileTail {
  private offset = 0;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private decoder = new TextDecoder("utf-8");
  private stopped = false;

  constructor(
    readonly path: string,
    private onData: (chunk: string) => void,
  ) {}

  start(): void {
    this.read();
    // The first read can make the caller stop (and follow another file).
    if (this.stopped) return;
    this.watcher = watch(this.path, {
      awaitWriteFinish: false,
      // Windows fs events can be missed for files held open by another process.
      usePolling: process.platform === "win32",
      interval: 250,
    });
    this.watcher.on("add", () => this.read());
    this.watcher.on("change", () => this.read());
    // Watchers can miss a file that does not exist yet; a cheap stat catches its creation.
    this.timer = setInterval(() => this.read(), 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.watcher?.close();
  }

  /** Reads what was appended since the last read, now. */
  poll(): void {
    this.read();
  }

  private read(): void {
    if (this.stopped) return;
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
  // chokidar misses files created later if their directory does not exist yet.
  mkdirSync(dirname(path), { recursive: true });
  const w = watch(path, { usePolling: process.platform === "win32", interval: 500 });
  w.on("add", onChange);
  w.on("change", onChange);
  return w;
}
