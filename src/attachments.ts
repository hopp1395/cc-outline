import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promptImageFile, resultFile } from "./images.js";
import { imageAction, isBrowserTool, SHOT_HINT } from "./transcript/chrome.js";
import { imagesLabel, turnScreenshots, type Turn } from "./transcript/parse.js";

/** Claude Code's placeholder of a pasted image in a prompt; its numbers count through the session. */
export const PASTED_MARK = /\[Image #(\d+)\]/g;

/**
 * The number of each of a prompt's `count` pasted images (in paste order):
 * the placeholders `[Image #n]` of its text in order, then, for images without
 * one (older transcripts, a prompt of images only), the numbers after them.
 */
export function pastedNumbers(prompt: string, count: number): number[] {
  if (count === 0) return [];
  const found = [...new Set([...prompt.matchAll(PASTED_MARK)].map((m) => Number(m[1])))].slice(0, count);
  let next = Math.max(0, ...found);
  while (found.length < count) found.push(++next);
  return found;
}

const cyan = (s: string) => `\u001b[36m${s}\u001b[39m`;

/**
 * `prompt` with its pasted images' placeholders in cyan, those without one
 * added at the end (a prompt of images only, `[Image]`, becomes its marks),
 * and with `hint` the key that lists them after the last.
 */
export function markedPrompt(prompt: string, count: number, hint: boolean): string {
  if (count === 0) return prompt;
  const numbers = pastedNumbers(prompt, count);
  const own = prompt === imagesLabel(count) ? "" : prompt;
  const present = new Set([...own.matchAll(PASTED_MARK)].map((m) => Number(m[1])));
  const added = numbers.filter((n) => !present.has(n)).map((n) => `[Image #${n}]`);
  // Added marks go on a line of their own after a prompt of several lines.
  const text = [own.trimEnd(), added.join(" ")].filter(Boolean).join(own.includes("\n") ? "\n" : " ");
  const marked = text.replace(PASTED_MARK, (m, n: string) => (numbers.includes(Number(n)) ? cyan(m) : m));
  return hint ? `${marked} ${SHOT_HINT}` : marked;
}

/**
 * Something that came with a turn and can be opened: an image pasted into
 * its prompt (`n` as in Claude Code's `[Image #n]`), a file or folder
 * mentioned with @, or an image or PDF a tool returned (`n` as its `[▣ n]` or
 * `[▤ n]` mark). `transcript` is where the data is when no copy is left; `at`
 * and `prompt` say when and with which prompt (the Sessions view lists them).
 */
export type AttachmentItem = PastedItem | MentionItem<"file"> | MentionItem<"directory"> | ResultItem<"image"> | ResultItem<"pdf">;

export interface PastedItem {
  kind: "pasted";
  n: number;
  uuid: string;
  index: number;
  upload?: string;
  transcript?: string;
  at?: string;
  prompt?: string;
}

export interface MentionItem<K extends "file" | "directory" = "file" | "directory"> {
  kind: K;
  path: string;
  full: string;
  at?: string;
  /** The prompts that mentioned it (Sessions: one entry per path). */
  uuids?: string[];
}

export interface ResultItem<K extends "image" | "pdf" = "image" | "pdf"> {
  kind: K;
  n: number;
  toolUseId: string;
  index: number;
  /** The file it was read from (Read), else the browser action or the tool. */
  label: string;
  saved?: string;
  page?: string;
  transcript?: string;
  at?: string;
  prompt?: string;
}

/** "claude-in-chrome · navigate" for "mcp__claude-in-chrome__navigate". */
function toolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

/** An @-mentioned path as an absolute one: `full` if the transcript named it, else relative to `cwd`. */
const absolute = (path: string, full: string | undefined, cwd: string | undefined) => full ?? (isAbsolute(path) || !cwd ? path : resolve(cwd, path));

/**
 * What can be opened of `turn`: its pasted images, its @-mentioned files and
 * folders, then the images and PDFs of its tool results. `transcript` is the
 * file the turn was read from when the turn does not say (`turn.transcript`).
 */
export function turnAttachments(turn: Turn, transcript?: string, cwd?: string): AttachmentItem[] {
  const file = turn.transcript ?? transcript;
  const items: AttachmentItem[] = [];
  let pasted = 0;
  const numbers = pastedNumbers(turn.prompt, (turn.attachments ?? []).filter((a) => a.kind === "image").length);
  for (const a of turn.attachments ?? []) {
    if (a.kind === "image") {
      const index = pasted++;
      items.push({ kind: "pasted", n: numbers[index], uuid: turn.id, index, ...(a.path ? { upload: a.path } : {}), ...(file ? { transcript: file } : {}) });
    }
  }
  for (const a of turn.attachments ?? []) {
    if (a.kind === "file" || a.kind === "directory") items.push({ kind: a.kind, path: a.path, full: absolute(a.path, a.full, cwd) });
  }
  // A task's result Claude Code cut (a workflow's, often): the file with all of it.
  const n = turn.notification;
  if (n?.outputFile && /\(truncated \d+ chars/.test(n.result ?? "")) items.push({ kind: "file", path: n.outputFile.replace(/\\/g, "/"), full: n.outputFile });
  for (const s of turnScreenshots(turn)) {
    if (!s.block.id) continue;
    const image = s.block.outcome?.images?.[s.index];
    const label = isBrowserTool(s.block.name) ? imageAction(s.block.name, s.block.input, image) : (image?.name ?? toolName(s.block.name));
    items.push({
      kind: s.kind,
      n: s.n,
      toolUseId: s.block.id,
      index: s.index,
      label,
      ...(image?.path ? { saved: image.path } : {}),
      ...(s.block.outcome?.page ? { page: s.block.outcome.page } : {}),
      ...(file ? { transcript: file } : {}),
    });
  }
  return items;
}

/** The images and PDFs among `items` (what the counters count: not the @-mentions). */
export const mediaCount = (items: AttachmentItem[]) => items.filter((i) => i.kind !== "file" && i.kind !== "directory").length;

/**
 * The file that shows `item`: the upload copy or saved copy if it is still
 * there, else its data from the transcript written to a temporary file, an
 * @-mentioned path if it still exists. `moved` maps a transcript to where it
 * is now (the trash).
 */
export function attachmentFile(item: AttachmentItem, moved: (transcript: string) => string = (t) => t): string | undefined {
  switch (item.kind) {
    case "pasted":
      return promptImageFile(item.transcript && moved(item.transcript), item.uuid, item.index, item.upload);
    case "image":
    case "pdf":
      return resultFile(item.transcript && moved(item.transcript), item.toolUseId, item.index, item.saved);
    default:
      return existsSync(item.full) ? item.full : undefined;
  }
}

/** How an item is named in messages: "image #2", "image 3", "PDF 1", "src/Foo.cs". */
export function attachmentTitle(item: AttachmentItem): string {
  switch (item.kind) {
    case "pasted":
      return `image #${item.n}`;
    case "image":
      return `image ${item.n}`;
    case "pdf":
      return `PDF ${item.n}`;
    default:
      return item.path.replace(/\\/g, "/");
  }
}

/** The item a clicked mark names: `[Image #n]` (pasted), `[▣ n]` (image) or `[▤ n]` (PDF). */
export function itemOfMark(items: AttachmentItem[], mark: { kind: "pasted" | "image" | "pdf"; n: number }): AttachmentItem | undefined {
  return items.find((i) => i.kind === mark.kind && i.n === mark.n);
}
