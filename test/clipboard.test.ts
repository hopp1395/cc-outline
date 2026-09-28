import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { clipboardMethod, copyToClipboard, nativeCommands, osc52 } from "../src/clipboard.js";
import { FrameBuffer } from "../src/tui/frameBuffer.js";

describe("clipboardMethod", () => {
  it("uses tmux inside tmux, also in Windows Terminal", () => {
    expect(clipboardMethod({ TMUX: "/tmp/tmux-1/default,1,0", WT_SESSION: "x" })).toBe("tmux");
  });

  it("uses OSC 52 in terminals that support it", () => {
    expect(clipboardMethod({ WT_SESSION: "x" })).toBe("osc52");
    expect(clipboardMethod({ WT_PROFILE_ID: "x" })).toBe("osc52");
    expect(clipboardMethod({ TERM_PROGRAM: "iTerm.app" })).toBe("osc52");
    expect(clipboardMethod({ TERM: "xterm-kitty" })).toBe("osc52");
  });

  it("falls back to the platform's program elsewhere", () => {
    expect(clipboardMethod({ TERM: "xterm-256color", VTE_VERSION: "7600" })).toBe("native");
    expect(clipboardMethod({})).toBe("native");
  });
});

describe("osc52", () => {
  it("encodes the text as UTF-8 base64", () => {
    expect(osc52("häh ✓")).toBe(`\u001b]52;c;${Buffer.from("häh ✓").toString("base64")}\u0007`);
  });

  it("is passed through the frame buffer without a redraw", () => {
    const written: string[] = [];
    const buffer = new FrameBuffer(Object.assign(new EventEmitter(), { columns: 20, rows: 5, write: (s: string) => written.push(s) }));
    buffer.write(osc52("x"));
    expect(written).toEqual([osc52("x")]);
  });
});

describe("nativeCommands", () => {
  it("picks the platform's clipboard programs", () => {
    expect(nativeCommands("x", "darwin").map((c) => c.cmd)).toEqual(["pbcopy"]);
    expect(nativeCommands("x", "linux", {}).map((c) => c.cmd)).toEqual(["xclip", "xsel"]);
    expect(nativeCommands("x", "linux", { WAYLAND_DISPLAY: "wayland-0" }).map((c) => c.cmd)).toEqual(["wl-copy", "xclip", "xsel"]);
  });

  it("hands clip UTF-16 with a byte order mark", () => {
    const [clip] = nativeCommands("ä", "win32");
    expect(clip.cmd).toBe("clip");
    expect([...clip.input]).toEqual([0xff, 0xfe, 0xe4, 0x00]);
  });
});

describe("copyToClipboard", () => {
  it("writes OSC 52 to the terminal", async () => {
    const written: string[] = [];
    await copyToClipboard("claude --resume abc", { write: (s) => written.push(s) }, "osc52");
    expect(written).toEqual([osc52("claude --resume abc")]);
  });
});
