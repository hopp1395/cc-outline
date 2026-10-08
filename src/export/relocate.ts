import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { extname, join } from "node:path";
import { claudeDir } from "../transcript/locate.js";

/**
 * Where a session's files go when they are imported or moved into another
 * project folder: the folders, ~/.claude, the project slugs and the ids.
 */
export interface Relocation {
  /** The project folder the session ran in; undefined when unknown (nothing is rewritten for it). */
  from?: string;
  to: string;
  /** The ~/.claude the files were written under; undefined when unknown (older archives) or the same. */
  claudeFrom?: string;
  claudeTo: string;
  slugFrom: string;
  slugTo: string;
  /** Old session id → new one; empty when the ids stay. */
  ids: Map<string, string>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isWindows = (p: string) => /^[a-zA-Z]:([\\/]|$)/.test(p);
const segments = (p: string) => p.split(/[\\/]+/).filter(Boolean);
// A path part goes on with these; anything else ends it (a separator, a quote, a space).
const AFTER = String.raw`(?![\w.\-])`;

/** One spelling of a path and what it becomes; `sep` is the separator the match used (group 1). */
interface Spelling {
  pattern: RegExp;
  replace: (sep: string) => string;
}

/**
 * The spellings of `from` that transcripts hold, each with its counterpart of `to`:
 * a Windows path as written (backslashes, also JSON-escaped once or twice, or slashes)
 * and as Git Bash writes it (`/c/…`); a POSIX path as it is. Only whole path parts
 * match, and on Windows without regard to case. `json`: written into JSON text, where
 * a backslash is escaped.
 */
function spellings(from: string, to: string, json: boolean): Spelling[] {
  const fromParts = segments(from);
  const toParts = segments(to);
  const toWindows = isWindows(to);
  const posixTo = "/" + toParts.join("/");
  if (isWindows(from)) {
    const [drive, ...rest] = fromParts;
    if (!drive || rest.length === 0) return [];
    const native = new RegExp(String.raw`(?<![\w.\-])` + escape(drive) + String.raw`(\\+|/)` + rest.map(escape).join(String.raw`(?:\\+|/)`) + AFTER, "gi");
    const gitBash = new RegExp(String.raw`(?<![\w.\-/\\])/` + escape(drive[0]!) + "(/)" + rest.map(escape).join("/") + AFTER, "gi");
    const [toDrive, ...toRest] = toParts;
    return [
      { pattern: native, replace: (sep) => (toWindows ? [toDrive, ...toRest].join(sep) : posixTo) },
      { pattern: gitBash, replace: () => (toWindows ? `/${toDrive![0]!.toLowerCase()}/${toRest.join("/")}` : posixTo) },
    ];
  }
  if (fromParts.length === 0) return [];
  const posix = new RegExp(String.raw`(?<![\w.\-/\\])/` + fromParts.map(escape).join("/") + "()" + AFTER, "g");
  const sep = json ? "\\\\" : "\\";
  return [{ pattern: posix, replace: () => (toWindows ? toParts.join(sep) : posixTo) }];
}

/** Whether `r` changes anything at all. */
export function changesAnything(r: Relocation): boolean {
  return (r.from !== undefined && r.from !== r.to) || (r.claudeFrom !== undefined && r.claudeFrom !== r.claudeTo) || r.slugFrom !== r.slugTo || r.ids.size > 0;
}

/**
 * Rewrites `text` (a transcript, a meta file, a tool result) for `r`: ~/.claude,
 * then the project folder, the slug below `projects` and the session ids.
 */
export function relocateText(text: string, r: Relocation, json: boolean): string {
  // Replaced paths wait behind placeholders, so the project folder is not looked for in
  // ~/.claude's new path (a project in the home folder holds it) and the reverse.
  const held: string[] = [];
  const hold = (s: string) => `\u0000${held.push(s) - 1}\u0000`;
  const swap = (from: string | undefined, to: string) => {
    if (from === undefined || from === to) return;
    for (const { pattern, replace } of spellings(from, to, json)) text = text.replace(pattern, (_m, sep: string) => hold(replace(sep)));
  };
  swap(r.claudeFrom, r.claudeTo);
  swap(r.from, r.to);
  if (r.slugFrom !== r.slugTo) {
    text = text.replace(new RegExp(String.raw`(projects(?:\\+|/))` + escape(r.slugFrom) + AFTER, "g"), (_m, before: string) => before + r.slugTo);
  }
  for (const [from, to] of r.ids) text = text.split(from).join(to);
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)]!);
}

/** A file's path relative to ~/.claude (forward slashes) where `r` puts it: the new slug and ids. */
export function relocatePath(rel: string, r: Relocation): string {
  const parts = rel.split("/");
  if (parts[0] === "projects" && parts[1] === r.slugFrom) parts[1] = r.slugTo;
  return parts
    .map((p) => {
      for (const [from, to] of r.ids) p = p.split(from).join(to);
      return p;
    })
    .join("/");
}

const TEXT_FILES = new Set([".jsonl", ".json", ".txt", ".md"]);

/**
 * Whether the file (relative to ~/.claude) is rewritten, not only copied: the
 * transcripts and what lies next to them. File history holds the user's files
 * as they were, and the session environment is the shell's; both stay as they are.
 */
export function rewrites(rel: string): boolean {
  return rel.startsWith("projects/") && TEXT_FILES.has(extname(rel).toLowerCase());
}

export const isJsonFile = (rel: string) => /\.jsonl?$/i.test(rel);

/** The project folders (slugs) whose transcripts include `<id>.jsonl`. */
export function slugsWith(id: string): string[] {
  const root = join(claudeDir(), "projects");
  try {
    return readdirSync(root).filter((slug) => existsSync(join(root, slug, `${id}.jsonl`)));
  } catch {
    return [];
  }
}

/** New ids for a chain whose ids are taken in another project folder; none when they are free. */
export function freshIds(ids: string[], slugTo: string): Map<string, string> {
  const taken = ids.some((id) => slugsWith(id).some((slug) => slug !== slugTo));
  return new Map(taken ? ids.map((id) => [id, randomUUID()]) : []);
}

/** The uuid of a transcript's first entry that has one: copies of a session (under new ids) share it. */
export function firstUuid(text: string): string | undefined {
  for (const line of text.split("\n", 50)) {
    const match = /"uuid":"([^"]+)"/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** Whether the project folder `dir` holds a transcript that begins with the entry `uuid`: a copy imported before. */
export function holdsCopy(dir: string, uuid: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return false;
  }
  const head = Buffer.alloc(64 * 1024);
  return names.some((n) => {
    let fd: number | undefined;
    try {
      fd = openSync(join(dir, n), "r");
      const read = readSync(fd, head, 0, head.length, 0);
      return firstUuid(head.subarray(0, read).toString("utf8")) === uuid;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  });
}

/** The folder a transcript ran in: its first entry that names one. */
export function firstCwd(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    } catch {
      // A damaged line: the next one may do.
    }
  }
  return undefined;
}
