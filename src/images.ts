import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Screenshot, Turn } from "./transcript/parse.js";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

interface ImageBlock {
  type?: string;
  source?: { type?: string; media_type?: string; data?: string };
}

/** Where images taken out of transcripts are written to be opened. */
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
 * Files showing the images pasted into `turn`'s prompt: the copies Claude Code
 * keeps under `~/.claude/uploads` where they still exist, otherwise the image
 * data from the transcript written to a temporary file. Images that are
 * neither are left out.
 */
export function turnImageFiles(transcript: string | undefined, turn: Turn): string[] {
  const images = (turn.attachments ?? []).filter((a) => a.kind === "image");
  if (images.length === 0) return [];
  let blocks: ImageBlock[] | undefined;
  const files: string[] = [];
  images.forEach((image, i) => {
    if (image.path && existsSync(image.path)) return void files.push(image.path);
    if (!transcript) return;
    blocks ??= entryImages(transcript, turn.id);
    const source = blocks[i]?.source;
    if (source?.type !== "base64" || !source.data) return;
    const file = join(imageDir(), `${turn.id}-${i + 1}.${EXTENSIONS[source.media_type ?? ""] ?? "png"}`);
    if (!existsSync(file)) {
      mkdirSync(imageDir(), { recursive: true });
      writeFileSync(file, Buffer.from(source.data, "base64"));
    }
    files.push(file);
  });
  return files;
}

/** The image blocks of the tool result for the call `toolUseId`. */
function resultImages(transcript: string, toolUseId: string): ImageBlock[] {
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
      if (result && Array.isArray(result.content)) return (result.content as ImageBlock[]).filter((b) => b?.type === "image");
    } catch {
      continue;
    }
  }
  return [];
}

/**
 * A file showing screenshot `shot` of a turn: the copy the desktop app's
 * Browser pane saved where it still exists, otherwise the image data of the
 * tool result in the transcript written to a temporary file; undefined when
 * neither is there.
 */
export function screenshotFile(transcript: string | undefined, shot: Screenshot): string | undefined {
  const saved = shot.block.outcome?.images?.[shot.index]?.path;
  if (saved && existsSync(saved)) return saved;
  const id = shot.block.id;
  if (!transcript || !id) return undefined;
  const source = resultImages(transcript, id)[shot.index]?.source;
  if (source?.type !== "base64" || !source.data) return undefined;
  const file = join(imageDir(), `${id}-${shot.index + 1}.${EXTENSIONS[source.media_type ?? ""] ?? "png"}`);
  if (!existsSync(file)) {
    mkdirSync(imageDir(), { recursive: true });
    writeFileSync(file, Buffer.from(source.data, "base64"));
  }
  return file;
}
