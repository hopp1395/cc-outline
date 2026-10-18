import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { proc } from "./proc.js";

/** The extensions of the files a copied file (Explorer, Finder) is taken as an image by. */
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"]);

/** An image taken from the clipboard into `dir`: its file, and where it came from (`bitmap`, `png`, or the copied file's name). */
export interface ClipboardImage {
  path: string;
  source: string;
}

/** What the clipboard held: the images saved, or why there were none. */
export type ClipboardRead = { images: ClipboardImage[] } | { images: []; reason: string };

/** A file name of its own in the images folder: time, then a few random characters. */
export function imageName(ext: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}${ext}`;
}

/**
 * Reads the clipboard's image on Windows, for PowerShell 5.1 (STA, so the clipboard works). Copied files
 * (Explorer: FileDrop) are listed as `file<TAB>path`; a PNG stream (browsers put one next to the bitmap, with
 * transparency) or else the bitmap (the Snipping Tool's) is written to CCO_IMAGE_FILE and named `png` or `bitmap`.
 * Prints nothing when the clipboard holds neither.
 */
export const CLIPBOARD_IMAGE_SCRIPT = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$d = [Windows.Forms.Clipboard]::GetDataObject()
if ($d -eq $null) { exit }
if ($d.GetDataPresent([Windows.Forms.DataFormats]::FileDrop)) {
  foreach ($f in $d.GetData([Windows.Forms.DataFormats]::FileDrop)) { [Console]::Out.WriteLine("file` + "`t" + String.raw`$f") }
  exit
}
$file = $env:CCO_IMAGE_FILE
if ($d.GetDataPresent('PNG')) {
  $s = $d.GetData('PNG')
  if ($s -is [IO.MemoryStream]) { [IO.File]::WriteAllBytes($file, $s.ToArray()); [Console]::Out.WriteLine('png'); exit }
}
$img = [Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) { $img.Save($file, [Drawing.Imaging.ImageFormat]::Png); [Console]::Out.WriteLine('bitmap') }
`;

const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

/** Runs a program and gives its stdout, or undefined if it could not be started or failed. */
function output(cmd: string, args: string[], env?: NodeJS.ProcessEnv, encoding: "utf8" | "buffer" = "utf8"): Promise<string | Buffer | undefined> {
  return new Promise((resolve) => {
    proc.execFile(
      cmd,
      args,
      { windowsHide: true, env: env ? { ...process.env, ...env } : process.env, encoding, maxBuffer: 64 * 1024 * 1024, timeout: 20_000 },
      (err, stdout) => resolve(err ? undefined : (stdout as string | Buffer)),
    );
  });
}

/** Copies the copied files that are images into `dir`; the others are named in the reason. */
function takeFiles(files: string[], dir: string): ClipboardRead {
  const images: ClipboardImage[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      skipped.push(basename(file));
      continue;
    }
    try {
      const path = join(dir, imageName(ext === ".jpeg" ? ".jpg" : ext));
      copyFileSync(file, path);
      images.push({ path, source: basename(file) });
    } catch {
      skipped.push(basename(file));
    }
  }
  if (images.length > 0) return { images };
  return { images: [], reason: skipped.length > 0 ? `not an image: ${skipped.join(", ")}` : "no image in the clipboard" };
}

/**
 * Saves the clipboard's image (or the image files copied in Explorer or Finder) into `dir`. On Windows through
 * PowerShell (about a second); on macOS through osascript (PNG only); elsewhere wl-paste or xclip.
 */
export async function readClipboardImages(dir: string, platform: NodeJS.Platform = process.platform): Promise<ClipboardRead> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, imageName(".png"));
  if (platform === "win32") {
    const out = await output("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded(CLIPBOARD_IMAGE_SCRIPT)], { CCO_IMAGE_FILE: path });
    if (out === undefined) return { images: [], reason: "the clipboard could not be read" };
    const lines = String(out).split(/\r?\n/).filter(Boolean);
    const files = lines.filter((l) => l.startsWith("file\t")).map((l) => l.slice(5));
    if (files.length > 0) return takeFiles(files, dir);
    const kind = lines[0]?.trim();
    return kind === "png" || kind === "bitmap" ? { images: [{ path, source: kind }] } : { images: [], reason: "no image in the clipboard" };
  }
  if (platform === "darwin") {
    const script = [`set f to open for access POSIX file ${JSON.stringify(path)} with write permission`, "write (the clipboard as «class PNGf») to f", "close access f"];
    const out = await output("osascript", script.flatMap((line) => ["-e", line]));
    return out !== undefined && sizeOf(path) > 0 ? { images: [{ path, source: "png" }] } : { images: [], reason: "no image in the clipboard" };
  }
  for (const [cmd, args] of [
    ["wl-paste", ["--no-newline", "--type", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-target", "image/png", "-out"]],
  ] as const) {
    const out = await output(cmd, [...args], undefined, "buffer");
    if (out instanceof Buffer && out.length > 0 && imageSize(out)) {
      writeFileSync(path, out);
      return { images: [{ path, source: "png" }] };
    }
  }
  return { images: [], reason: "no image in the clipboard (wl-paste or xclip needed)" };
}

/** How the prompt editor reads the clipboard, read at each paste, so tests can swap in a platform. */
export const clipboardImages = { read: (dir: string) => readClipboardImages(dir) };

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** The pixel size of a PNG, JPEG, GIF, BMP or WebP image, from its first bytes; undefined for anything else. */
export function imageSize(data: Buffer): { width: number; height: number } | undefined {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length >= 10 && data.toString("latin1", 0, 3) === "GIF") return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (data.length >= 26 && data.toString("latin1", 0, 2) === "BM") return { width: data.readInt32LE(18), height: Math.abs(data.readInt32LE(22)) };
  if (data.length >= 30 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
    const chunk = data.toString("latin1", 12, 16);
    if (chunk === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = data.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return undefined;
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    // JPEG: the first start-of-frame marker (C0–CF without C4, C8, CC) holds height and width.
    let at = 2;
    while (at + 9 < data.length) {
      if (data[at] !== 0xff) return undefined;
      const marker = data[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
      at += 2 + data.readUInt16BE(at + 2);
    }
  }
  return undefined;
}

/** The pixel size of the image file `path`, from its first 64 KB. */
export function imageFileSize(path: string): { width: number; height: number } | undefined {
  try {
    return imageSize(readFileSync(path).subarray(0, 64 * 1024));
  } catch {
    return undefined;
  }
}
