import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Screenshot, Turn } from "./transcript/parse.js";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf" };

interface ImageBlock {
  type?: string;
  source?: { type?: string; media_type?: string; data?: string };
}

/** Where images and PDFs taken out of transcripts are written to be opened. */
export function imageDir(): string {
  return join(tmpdir(), "cco-images");
}

/** The image blocks of the transcript entry `uuid`: a prompt's content, or a queued prompt's. */
function entryImages(transcript: string, uuid: string): ImageBlock[] {
  let text: string;
  try {
    text = readFileSync(transcript, "utf8");
  } catch {
    return [];
  }
  for (const line of text.split("\n")) {
    if (!line.includes(uuid)) continue;
    try {
      const entry = JSON.parse(line) as { uuid?: string; message?: { content?: unknown }; attachment?: { prompt?: unknown } };
      if (entry.uuid !== uuid) continue;
      const content = entry.message?.content ?? entry.attachment?.prompt;
      return Array.isArray(content) ? (content as ImageBlock[]).filter((b) => b?.type === "image") : [];
    } catch {
      continue;
    }
  }
  return [];
}

/**
 * The file showing image `index` (from 0) pasted into `turn`'s prompt: the
 * copy Claude Code keeps under `~/.claude/uploads` if it still exists,
 * otherwise the image data from the transcript written to a temporary file;
 * undefined if it is neither.
 */
export function turnImageFile(transcript: string | undefined, turn: Turn, index: number): string | undefined {
  const image = (turn.attachments ?? []).filter((a) => a.kind === "image")[index];
  if (!image) return undefined;
  return promptImageFile(transcript, turn.id, index, image.path);
}

/**
 * The file showing image `index` (from 0) of the prompt entry `uuid`:
 * `upload` (its copy under `~/.claude/uploads`) if it still exists, otherwise
 * the image data from the transcript written to a temporary file.
 */
export function promptImageFile(transcript: string | undefined, uuid: string, index: number, upload?: string): string | undefined {
  if (upload && existsSync(upload)) return upload;
  if (!transcript) return undefined;
  return written(entryImages(transcript, uuid)[index], `${uuid}-${index + 1}`);
}

/** `block`'s base64 data written to `<imageDir>/<base>.<ext>` (once); undefined without data. */
function written(block: ImageBlock | undefined, base: string): string | undefined {
  const source = block?.source;
  if (source?.type !== "base64" || !source.data) return undefined;
  const file = join(imageDir(), `${base}.${EXTENSIONS[source.media_type ?? ""] ?? "png"}`);
  if (!existsSync(file)) {
    mkdirSync(imageDir(), { recursive: true });
    writeFileSync(file, Buffer.from(source.data, "base64"));
  }
  return file;
}

/** The image and document (PDF) blocks of the tool result for the call `toolUseId`. */
function resultFiles(transcript: string, toolUseId: string): ImageBlock[] {
  let text: string;
  try {
    text = readFileSync(transcript, "utf8");
  } catch {
    return [];
  }
  for (const line of text.split("\n")) {
    if (!line.includes(toolUseId) || !line.includes("tool_result")) continue;
    try {
      const entry = JSON.parse(line) as { message?: { content?: unknown } };
      const content = Array.isArray(entry.message?.content) ? (entry.message.content as { type?: string; tool_use_id?: string; content?: unknown }[]) : [];
      const result = content.find((b) => b?.type === "tool_result" && b.tool_use_id === toolUseId);
      if (result && Array.isArray(result.content)) return (result.content as ImageBlock[]).filter((b) => b?.type === "image" || b?.type === "document");
    } catch {
      continue;
    }
  }
  return [];
}

/**
 * A file showing image (or PDF) `shot` of a turn's tool results: the copy the
 * desktop app's Browser pane saved where it still exists, otherwise the data
 * of the tool result in the transcript written to a temporary file; undefined
 * when neither is there.
 */
export function screenshotFile(transcript: string | undefined, shot: Screenshot): string | undefined {
  const id = shot.block.id;
  return id ? resultFile(transcript, id, shot.index, shot.block.outcome?.images?.[shot.index]?.path) : undefined;
}

/**
 * A file showing image or PDF `index` (from 0) of the result of the call
 * `toolUseId`: `saved` if it still exists, otherwise its data from the
 * transcript written to a temporary file.
 */
export function resultFile(transcript: string | undefined, toolUseId: string, index: number, saved?: string): string | undefined {
  if (saved && existsSync(saved)) return saved;
  if (!transcript) return undefined;
  return written(resultFiles(transcript, toolUseId)[index], `${toolUseId}-${index + 1}`);
}
