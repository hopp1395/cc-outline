import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clipboardImages, imageSize, readClipboardImages } from "../src/clipboardImage.js";
import { proc } from "../src/proc.js";
import { promptLineSteps } from "../src/switchSession.js";
import {
  cleanupPromptFiles,
  draftFile,
  fromPromptText,
  nextImageNumber,
  promptImageDir,
  promptText,
  readDraft,
  removeImage,
  saveDraft,
  type PromptImage,
} from "../src/promptDraft.js";
import { claudeSettingsFile, editInViewer, isCcoEditor, readEditorSetup, readReply, removeEditor, replyFile, setUpEditor, writeReply } from "../src/promptEdit.js";
import { controlFile, readJson } from "../src/transcript/locate.js";
import type { ControlRequest } from "../src/viewer.js";
import { PromptEditor, rowStep, wordStep } from "../src/tui/PromptEditor.js";
import type { Layout } from "../src/tui/layout.js";
import { renderInk } from "./helpers/ink.js";

/** A PNG's signature and IHDR, enough for its size. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-prompt-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

// PowerShell reading the clipboard: writes a PNG where it is told to, like CLIPBOARD_IMAGE_SCRIPT.
const real = { ...proc };
const realImages = { ...clipboardImages };
let clipboardAnswer: "png" | "none" | { files: string[] } = "png";
beforeAll(() => {
  proc.execFile = ((cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }, done: (err: Error | null, stdout: string) => void) => {
    if (cmd !== "powershell.exe") return done(new Error("not faked"), "");
    if (clipboardAnswer === "png") {
      writeFileSync(opts.env!.CCO_IMAGE_FILE!, png(640, 480));
      return done(null, "png\r\n");
    }
    if (clipboardAnswer === "none") return done(null, "");
    return done(null, clipboardAnswer.files.map((f) => `file\t${f}`).join("\r\n"));
  }) as never;
  proc.spawn = (() => Object.assign(new EventEmitter(), { unref: () => {} })) as never;
  // The editor reads the clipboard as on Windows, wherever the tests run.
  clipboardImages.read = (dir) => readClipboardImages(dir, "win32");
});
afterAll(() => {
  Object.assign(proc, real);
  Object.assign(clipboardImages, realImages);
});

const image = (n: number, path = join(promptImageDir(), `img-${n}.png`)): PromptImage => ({ n, path, source: "bitmap", bytes: 10, at: 0 });

describe("prompt drafts", () => {
  it("hands over the images' paths in quotes and takes them back as placeholders", () => {
    const images = [image(1), image(2)];
    const text = promptText({ text: "look at [Image #1] and [Image #2], not [Image #9]", images });
    expect(text).toBe(`look at "${images[0]!.path}" and "${images[1]!.path}", not [Image #9]`);
    expect(fromPromptText(text, images)).toEqual({ text: "look at [Image #1] and [Image #2], not [Image #9]", images });
  });

  it("lists an image of the images folder named in Claude Code's prompt line", () => {
    mkdirSync(promptImageDir(), { recursive: true });
    const path = join(promptImageDir(), "earlier.png");
    writeFileSync(path, png(10, 20));
    const draft = fromPromptText(`see "${path}" and "C:\\elsewhere\\x.png"`, [image(3)], promptImageDir(), 5);
    expect(draft.text).toBe('see [Image #4] and "C:\\elsewhere\\x.png"');
    expect(draft.images[1]).toMatchObject({ n: 4, path, width: 10, height: 20, source: "earlier prompt" });
  });

  it("removes an image with its placeholder and never reuses a number", () => {
    const draft = removeImage({ text: "a [Image #1] b [Image #2]", images: [image(1), image(2)] }, 1);
    expect(draft).toEqual({ text: "a b [Image #2]", images: [image(2)] });
    expect(nextImageNumber(draft.images)).toBe(3);
  });

  it("keeps a draft per session on disk and removes an empty one", () => {
    saveDraft("s1", { text: "hello", images: [image(1)] });
    expect(readDraft("s1")).toEqual({ text: "hello", images: [image(1)] });
    saveDraft("s1", { text: "", images: [] });
    expect(existsSync(draftFile("s1"))).toBe(false);
  });

  it("deletes images and drafts after 30 days", () => {
    mkdirSync(promptImageDir(), { recursive: true });
    const old = join(promptImageDir(), "old.png");
    const fresh = join(promptImageDir(), "fresh.png");
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);
    cleanupPromptFiles();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("clipboard images", () => {
  it("reads the size of PNG, GIF and JPEG images", () => {
    expect(imageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    const gif = Buffer.alloc(10);
    gif.write("GIF89a", 0, "latin1");
    gif.writeUInt16LE(32, 6);
    gif.writeUInt16LE(16, 8);
    expect(imageSize(gif)).toEqual({ width: 32, height: 16 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03]);
    expect(imageSize(jpeg)).toEqual({ width: 600, height: 300 });
    expect(imageSize(Buffer.from("not an image"))).toBeUndefined();
  });

  it("saves the clipboard's image, and copies copied image files", async () => {
    const dir = promptImageDir();
    clipboardAnswer = "png";
    const read = await readClipboardImages(dir, "win32");
    expect(read.images).toHaveLength(1);
    expect(read.images[0]!.source).toBe("png");
    expect(imageSize(readFileSync(read.images[0]!.path))).toEqual({ width: 640, height: 480 });

    const copied = join(mkdtempSync(join(tmpdir(), "cco-copied-")), "Shot 1.PNG");
    writeFileSync(copied, png(2, 2));
    const notes = join(tmpdir(), "notes.txt");
    clipboardAnswer = { files: [copied, notes] };
    const files = await readClipboardImages(dir, "win32");
    expect(files.images.map((i) => i.source)).toEqual(["Shot 1.PNG"]);
    expect(files.images[0]!.path.endsWith(".png")).toBe(true);

    clipboardAnswer = { files: [notes] };
    expect(await readClipboardImages(dir, "win32")).toEqual({ images: [], reason: "not an image: notes.txt" });
    clipboardAnswer = "none";
    expect(await readClipboardImages(dir, "win32")).toEqual({ images: [], reason: "no image in the clipboard" });
  });
});

describe("typing into Claude Code", () => {
  it("puts line breaks in as Ctrl+J and sends nothing", () => {
    expect(promptLineSteps("one\n\ntwo")).toEqual([
      ["one", 0, 0, 0],
      ["\n", 0x4a, 8, 0],
      ["\n", 0x4a, 8, 0],
      ["two", 0, 0, 0],
    ]);
  });
});

describe("cursor steps", () => {
  it("moves by word and by row", () => {
    expect(wordStep("one two  three", 14, -1)).toBe(9);
    expect(wordStep("one two  three", 0, 1)).toBe(4);
    // Rows of 5 columns: "abcde", "fgh"; then "xy" after the line break.
    const text = "abcdefgh\nxy";
    expect(rowStep(text, 2, 5, 1)).toBe(7);
    expect(rowStep(text, 7, 5, 1)).toBe(11);
    expect(rowStep(text, 10, 5, -1)).toBe(6);
    expect(rowStep(text, 3, 5, -1)).toBe(0);
  });
});

const layout: Layout = { columns: 80, rows: 20, listWidth: 0, previewWidth: 80, bodyHeight: 20 };

describe("PromptEditor", () => {
  const editor = (props: Partial<Parameters<typeof PromptEditor>[0]> = {}) => {
    const done: { text?: string; cancelled?: boolean } = {};
    const view = renderInk(
      <PromptEditor
        layout={layout}
        title="Prompt for Claude Code · test"
        detail="where it goes"
        draftKey="s1"
        onSubmit={(text) => (done.text = text)}
        onCancel={() => (done.cancelled = true)}
        {...props}
      />,
      layout,
    );
    return { view, done };
  };

  it("starts new lines with Enter and hands over with Ctrl+S or Ctrl+Enter", async () => {
    const { view, done } = editor();
    await expect.poll(view.frame).toContain("[ Hand over to Claude ]");
    await view.press("first");
    await view.press("\r");
    await view.press("second");
    await expect.poll(view.frame).toContain("line 2/2");
    expect(view.frame()).toContain("› first");
    await view.press("\u0013");
    await expect.poll(() => done.text).toBe("first\nsecond");
    view.unmount();

    const again = editor({ draftKey: "s2" });
    await again.view.press("one");
    // Ctrl+Enter reaches Windows Terminal's apps as a line feed.
    await again.view.press("\n");
    await expect.poll(() => again.done.text).toBe("one");
    again.view.unmount();
  });

  it("keeps the draft when closed with Esc, and Claude Code's prompt line wins over it", async () => {
    const { view, done } = editor();
    await view.press("kept for later");
    await view.press("\u001b");
    await expect.poll(() => done.cancelled).toBe(true);
    view.unmount();
    expect(readDraft("s1").text).toBe("kept for later");

    const reopened = editor();
    await expect.poll(reopened.view.frame).toContain("kept for later");
    reopened.view.unmount();
    const fromClaude = editor({ initialText: "typed in Claude Code\n" });
    await expect.poll(fromClaude.view.frame).toContain("typed in Claude Code");
    expect(fromClaude.view.frame()).not.toContain("kept for later");
    fromClaude.view.unmount();
  });

  it("pastes the clipboard's image with Alt+V and hands over its path", async () => {
    clipboardAnswer = "png";
    const { view, done } = editor();
    await view.press("see");
    await view.press("\u001bv");
    await expect.poll(view.frame).toContain("see [Image #1]");
    expect(view.frame()).toContain("⎘ 1 image");
    // Tab goes to the button first, then to the images; Shift+Tab from the text straight to them.
    await view.press("\t");
    await expect.poll(view.frame).toContain("Tab images");
    expect(view.frame()).not.toContain("640×480");
    await view.press("\t");
    await expect.poll(view.frame).toContain("640×480");
    await view.press("\t");
    await expect.poll(view.frame).toContain("Alt+V image");
    await view.press("\u001b[Z");
    await expect.poll(view.frame).toContain("640×480");
    await view.press("\u001b");
    // Back in the text: Ink holds a lone Esc a moment, a key right after it would join it.
    await expect.poll(view.frame).toContain("Alt+V image");
    await view.press("\u0013");
    await expect.poll(() => done.text).toMatch(/^see "[^"]+\.png"$/);
    view.unmount();
  });

  it("says so when the clipboard holds no image", async () => {
    clipboardAnswer = "none";
    const { view } = editor();
    await view.press("\u001bv");
    await expect.poll(view.frame).toContain("no image in the clipboard");
    view.unmount();
  });
});

describe("cco edit", () => {
  it("sets VISUAL in Claude Code's settings and puts the one before back", () => {
    writeFileSync(claudeSettingsFile(), JSON.stringify({ model: "opus", env: { VISUAL: "code -w" } }));
    expect(readEditorSetup()).toMatchObject({ visual: "code -w", cco: false });
    const cli = join(mkdtempSync(join(tmpdir(), "cco-cli-")), "cli.js");
    writeFileSync(cli, "");
    setUpEditor(`"node" "${cli}" edit`);
    const settings = JSON.parse(readFileSync(claudeSettingsFile(), "utf8"));
    expect(settings).toEqual({ model: "opus", env: { VISUAL: `"node" "${cli}" edit` } });
    expect(readEditorSetup()).toMatchObject({ cco: true, stale: false });
    expect(existsSync(`${claudeSettingsFile()}.cco-backup`)).toBe(true);
    removeEditor();
    expect(JSON.parse(readFileSync(claudeSettingsFile(), "utf8"))).toEqual({ model: "opus", env: { VISUAL: "code -w" } });
    setUpEditor('"node" "C:\\gone\\cli.js" edit');
    expect(readEditorSetup()).toMatchObject({ cco: true, stale: true });
    expect(isCcoEditor("notepad")).toBe(false);
  });

  it("leaves a settings.json that is no JSON alone", () => {
    writeFileSync(claudeSettingsFile(), "{ // comment");
    expect(readEditorSetup().unreadable).toBe(true);
    expect(() => setUpEditor()).toThrow(/no valid JSON/);
  });

  it("asks the viewer, waits until it is done, and falls back when it declines", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cco-edit-project-"));
    const file = join(mkdtempSync(join(tmpdir(), "cco-edit-")), "prompt.md");
    writeFileSync(file, "");
    // The viewer: opens, then hands over.
    const said: string[] = [];
    const waiting = editInViewer(cwd, 4242, process.pid, file, (t) => said.push(t));
    await expect.poll(() => readJson<ControlRequest>(controlFile(cwd, 4242))?.edit?.file).toBe(file);
    writeReply(file, "open");
    await expect.poll(() => said.length).toBe(1);
    writeReply(file, "done");
    expect(await waiting).toBe("done");
    expect(existsSync(replyFile(file))).toBe(false);
    expect(readReply(file)).toBeUndefined();

    // A viewer that does not answer in time.
    expect(await editInViewer(cwd, 4242, process.pid, file, () => {})).toBe("declined");
  });
});
