import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { imageFileSize, type ClipboardImage } from "./clipboardImage.js";
import { claudeDir, readJson, writeJson } from "./transcript/locate.js";

/** Images and drafts of the prompt editor are deleted this long after they were last written. */
export const PROMPT_FILES_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** An image of a prompt draft: shown in the text as `[Image #n]`, which stays its number while it is in the draft. */
export interface PromptImage {
  n: number;
  path: string;
  /** Where it came from: `bitmap`, `png`, or the copied file's name. */
  source: string;
  width?: number;
  height?: number;
  bytes: number;
  /** Epoch ms it was added. */
  at: number;
}

/** What the prompt editor keeps per session until it is handed to Claude Code. */
export interface PromptDraft {
  text: string;
  images: PromptImage[];
}

export const EMPTY_DRAFT: PromptDraft = { text: "", images: [] };

/** Where the images pasted into the prompt editor are kept (global, like the settings: a prompt may name them later). */
export const promptImageDir = () => join(claudeDir(), "cco", "images");
const draftDir = () => join(claudeDir(), "cco", "drafts");
/** A draft's file: one per session id (or other key), its characters kept to what a file name takes. */
export const draftFile = (key: string) => join(draftDir(), `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

const isImage = (v: unknown): v is PromptImage => {
  const i = v as PromptImage;
  return typeof i === "object" && i !== null && Number.isInteger(i.n) && typeof i.path === "string" && typeof i.source === "string" && typeof i.bytes === "number";
};

/** The draft kept for `key`; an empty one if there is none or it is not readable. */
export function readDraft(key: string): PromptDraft {
  const d = readJson<Partial<PromptDraft>>(draftFile(key));
  return { text: typeof d?.text === "string" ? d.text : "", images: Array.isArray(d?.images) ? d.images.filter(isImage) : [] };
}

/** Keeps the draft for `key`; an empty one removes the file. */
export function saveDraft(key: string, draft: PromptDraft): void {
  if (!draft.text && draft.images.length === 0) return clearDraft(key);
  mkdirSync(draftDir(), { recursive: true });
  writeJson(draftFile(key), draft);
}

export function clearDraft(key: string): void {
  rmSync(draftFile(key), { force: true });
}

/** How an image stands in the editor's text. */
export const placeholder = (n: number) => `[Image #${n}]`;
const PLACEHOLDER = /\[Image #(\d+)\]/g;

/** The numbers of the images whose placeholder is in `text`. */
export function referenced(text: string): Set<number> {
  return new Set([...text.matchAll(PLACEHOLDER)].map((m) => Number(m[1])));
}

/** The next free image number: one above the highest in the draft, so numbers never change or come back while it lasts. */
export const nextImageNumber = (images: PromptImage[]) => Math.max(0, ...images.map((i) => i.n)) + 1;

/** Images read from the clipboard as images of the draft, numbered from `first`. */
export function draftImages(read: ClipboardImage[], first: number, now = Date.now()): PromptImage[] {
  return read.map((image, i) => {
    const size = imageFileSize(image.path);
    let bytes = 0;
    try {
      bytes = statSync(image.path).size;
    } catch {
      // gone again: shown with 0 bytes
    }
    return { n: first + i, path: image.path, source: image.source, ...size, bytes, at: now };
  });
}

/**
 * The text handed to Claude Code: each placeholder becomes its image's path in double quotes, which Claude reads
 * with its Read tool (a typed path is not attached like a pasted image). A placeholder of an image no longer in
 * the draft stays as typed. Trimmed.
 */
export function promptText(draft: PromptDraft): string {
  const byNumber = new Map(draft.images.map((i) => [i.n, i]));
  return draft.text.replace(PLACEHOLDER, (whole, n: string) => {
    const image = byNumber.get(Number(n));
    return image ? `"${image.path}"` : whole;
  }).trim();
}

/**
 * The editor's draft for a text that comes back from Claude Code (Ctrl+G with text in its prompt line): the
 * quoted paths of images in the images folder become placeholders again, those of the draft with their number,
 * others as new images of it. The draft's other images stay listed.
 */
export function fromPromptText(text: string, images: PromptImage[], dir = promptImageDir(), now = Date.now()): PromptDraft {
  const all = [...images];
  const folder = resolve(dir).toLowerCase();
  const out = text.replace(/"([^"\r\n]+)"/g, (whole, path: string) => {
    if (!resolve(path).toLowerCase().startsWith(folder)) return whole;
    const known = all.find((i) => resolve(i.path).toLowerCase() === resolve(path).toLowerCase());
    if (known) return placeholder(known.n);
    if (!existsSync(path)) return whole;
    const [image] = draftImages([{ path, source: "earlier prompt" }], nextImageNumber(all), now);
    all.push(image!);
    return placeholder(image!.n);
  });
  return { text: out, images: all };
}

/** Removes image `n` from the draft and its placeholder from the text, with one space that followed it. */
export function removeImage(draft: PromptDraft, n: number): PromptDraft {
  return { text: draft.text.split(`${placeholder(n)} `).join("").split(placeholder(n)).join(""), images: draft.images.filter((i) => i.n !== n) };
}

/** Deletes images and drafts not written for `PROMPT_FILES_AGE_MS`; for the SessionStart hook, so it never throws. */
export function cleanupPromptFiles(now = Date.now()): void {
  for (const dir of [promptImageDir(), draftDir()]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(dir, name);
      try {
        if (now - statSync(file).mtimeMs > PROMPT_FILES_AGE_MS) rmSync(file, { force: true });
      } catch {
        // gone or in use: next time
      }
    }
  }
}
