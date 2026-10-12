import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { knownMarketplaceSource, pluginState, type PluginState } from "./accountSetup.js";
import { inClaudeDir, projectSlug } from "./transcript/locate.js";
import { runningSessions, type RunningSession } from "./transcript/trash.js";
import { readTransfers } from "./transfers.js";

/** The cco plugin in an account's config folder, and where its marketplace comes from. */
export interface AccountPlugin extends PluginState {
  source?: string;
}

/** The sessions of one project in an account's config folder, as far as a quick look tells. */
export interface AccountSessions {
  /** Transcripts with a conversation (Claude Code also writes tiny bookkeeping ones). */
  count: number;
  /** The one written last: when, and its title (`/rename`, else Claude Code's). */
  newest?: { at: number; title?: string };
  /** Sessions continued in another account (⇢) and copies from another one (⇠). */
  continuedIn: number;
  continuedFrom: number;
}

export function accountPlugin(dir: string): AccountPlugin {
  return { ...pluginState(dir), source: knownMarketplaceSource(dir) };
}

/** The Claude Codes that run under the account of `dir` now. */
export function accountRunning(dir: string): (RunningSession & { sessionId: string })[] {
  return [...inClaudeDir(dir, runningSessions)].map(([sessionId, r]) => ({ ...r, sessionId }));
}

/** Reads at most `bytes` from `offset` of `file`. */
function readPart(file: string, offset: number, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, offset);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const TAIL = 128 * 1024;

/** The title a transcript ends with: its last `custom-title`, else its last `ai-title`; only its end is read. */
export function transcriptTitle(file: string, size: number): string | undefined {
  const text = readPart(file, Math.max(0, size - TAIL), Math.min(size, TAIL));
  let custom: string | undefined;
  let ai: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('-title"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; customTitle?: string; aiTitle?: string };
      if (entry.type === "custom-title" && entry.customTitle?.trim()) custom = entry.customTitle.trim();
      if (entry.type === "ai-title" && entry.aiTitle?.trim()) ai = entry.aiTitle.trim();
    } catch {
      // The first line of the tail is cut, and a line may be half written.
    }
  }
  return custom ?? ai;
}

/** Whether a transcript holds a conversation: large ones are taken to, small ones are looked into. */
function hasConversation(file: string, size: number): boolean {
  if (size > 64 * 1024) return true;
  const text = readPart(file, 0, size);
  return text.includes('"type":"user"') || text.includes('"type":"assistant"');
}

/** The sessions of the project `cwd` in the account of `dir`, without reading the transcripts in full. */
export function accountSessions(dir: string, cwd: string): AccountSessions {
  const folder = join(dir, "projects", projectSlug(cwd));
  let files: { path: string; at: number; size: number }[] = [];
  try {
    files = readdirSync(folder)
      .filter((n) => n.endsWith(".jsonl"))
      .flatMap((n) => {
        const path = join(folder, n);
        try {
          const { mtimeMs, size } = statSync(path);
          return [{ path, at: mtimeMs, size }];
        } catch {
          return [];
        }
      })
      .filter((f) => hasConversation(f.path, f.size))
      .sort((a, b) => b.at - a.at);
  } catch {
    // No session of this project in that account.
  }
  const transfers = Object.values(inClaudeDir(dir, () => readTransfers(cwd)));
  const newest = files[0];
  return {
    count: files.length,
    newest: newest && { at: newest.at, title: transcriptTitle(newest.path, newest.size) },
    continuedIn: transfers.filter((t) => t.to?.length).length,
    continuedFrom: transfers.filter((t) => t.from).length,
  };
}
