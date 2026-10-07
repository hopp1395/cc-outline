import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Gives a session a new title the way /rename does: a `custom-title` entry appended to its transcript,
 * which Claude Code (`/resume`, the tab title) and cco take as the title from then on. Only for a session
 * that runs nowhere: a running Claude Code writes its own title again. `path` is the transcript the
 * session continues in, the last of a chain.
 */
export function renameSession(path: string, sessionId: string, title: string): void {
  const entry = JSON.stringify({ type: "custom-title", customTitle: title, sessionId });
  appendFileSync(path, `${endsInNewline(path) ? "" : "\n"}${entry}\n`);
}

/** Whether the file is empty or its last byte is a line break, so an appended line starts a line of its own. */
function endsInNewline(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}
