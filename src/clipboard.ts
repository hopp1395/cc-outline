import { spawn } from "node:child_process";

/**
 * How text reaches the clipboard:
 * - `osc52`: an OSC 52 sequence written to the terminal, which sets the
 *   clipboard itself (Windows Terminal, iTerm2, WezTerm, kitty, …). Needs no
 *   program, and works over SSH too.
 * - `tmux`: `tmux load-buffer -w`, which fills tmux's buffer and passes it on
 *   to the outer terminal's clipboard (tmux only forwards OSC 52 from
 *   programs with `set-clipboard on`, which is not the default).
 * - `native`: the platform's clipboard program (pbcopy, wl-copy, xclip,
 *   xsel, clip), for terminals without OSC 52 such as GNOME Terminal.
 */
export type ClipboardMethod = "osc52" | "tmux" | "native";

export function clipboardMethod(env: NodeJS.ProcessEnv = process.env): ClipboardMethod {
  if (env.TMUX) return "tmux";
  if (env.WT_SESSION || env.WT_PROFILE_ID || env.KITTY_WINDOW_ID || env.WEZTERM_PANE) return "osc52";
  if (["iTerm.app", "WezTerm", "ghostty"].includes(env.TERM_PROGRAM ?? "")) return "osc52";
  if (/^(xterm-kitty|xterm-ghostty|alacritty|foot)/.test(env.TERM ?? "")) return "osc52";
  return "native";
}

/** The OSC 52 sequence that puts `text` on the clipboard. */
export function osc52(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

interface Command {
  cmd: string;
  args: string[];
  input: Buffer;
}

/** The clipboard programs to try, in order, for `platform`. */
export function nativeCommands(text: string, platform: NodeJS.Platform = process.platform, env = process.env): Command[] {
  const utf8 = Buffer.from(text, "utf8");
  if (platform === "darwin") return [{ cmd: "pbcopy", args: [], input: utf8 }];
  if (platform === "win32") {
    // clip reads the console code page unless the input starts with a UTF-16 byte order mark.
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    return [{ cmd: "clip", args: [], input: utf16 }];
  }
  const commands: Command[] = [
    { cmd: "xclip", args: ["-selection", "clipboard"], input: utf8 },
    { cmd: "xsel", args: ["--clipboard", "--input"], input: utf8 },
  ];
  if (env.WAYLAND_DISPLAY) commands.unshift({ cmd: "wl-copy", args: [], input: utf8 });
  return commands;
}

function run({ cmd, args, input }: Command): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
    child.stdin.on("error", () => {}); // reported by "close" or "error"
    child.stdin.end(input);
  });
}

async function firstThatWorks(commands: Command[]): Promise<boolean> {
  for (const command of commands) {
    try {
      await run(command);
      return true;
    } catch {
      // try the next one
    }
  }
  return false;
}

/**
 * Puts `text` on the clipboard, the way `clipboardMethod` says. `out` is the
 * terminal the OSC 52 sequence goes to (Ink's stdout, which passes a write of
 * only OSC sequences through without redrawing). Where no program works, it
 * falls back to OSC 52, which the terminal may or may not understand.
 */
export async function copyToClipboard(
  text: string,
  out: { write(s: string): unknown },
  method: ClipboardMethod = clipboardMethod(),
): Promise<void> {
  if (method === "tmux") {
    const input = Buffer.from(text, "utf8");
    // -w (tmux 3.2) also sets the outer terminal's clipboard; older ones only fill the buffer.
    const done = await firstThatWorks([
      { cmd: "tmux", args: ["load-buffer", "-w", "-"], input },
      { cmd: "tmux", args: ["load-buffer", "-"], input },
    ]);
    if (done) return;
  }
  if (method === "native" && (await firstThatWorks(nativeCommands(text)))) return;
  out.write(osc52(text));
}
