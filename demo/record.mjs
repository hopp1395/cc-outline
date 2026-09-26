// Records the README demo: Claude Code (a simplified stand-in) runs /cco:chat,
// the window splits, and the real viewer runs headlessly on a demo project in
// the right pane while a key script plays. Writes the frames to docs/ as SVG.
// Run with `npm run demo` (builds demo/.out/App.js first).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { framesToSvg, frameToSvg } from "./ansi-svg.mjs";
import { claudeScreen } from "./claude-mock.mjs";
import { createDemo } from "./fixture.mjs";

/** Claude Code pane, pane border, viewer pane. */
const LEFT = 46;
const RIGHT = 96;
const COLUMNS = LEFT + 1 + RIGHT;
const ROWS = 28;
const TITLE = "Claude Code with cc-outline";

const root = mkdtempSync(join(tmpdir(), "cco-demo-"));
const { cwd, configDir } = createDemo(root);
// Must be set before the viewer is imported: it reads transcripts and settings from here.
process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.WT_SESSION = "demo";
delete process.env.TMUX;

const { render } = await import("ink");
const { createElement } = await import("react");
const { App } = await import("./.out/App.js");

const stdout = new PassThrough();
stdout.columns = RIGHT;
stdout.rows = ROWS;
stdout.isTTY = true;
// In debug mode Ink writes every frame in full, in one write and without a
// trailing newline, so the last write is the current screen.
let screen = "";
stdout.on("data", (d) => (screen = String(d)));
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.ref = () => {};
stdin.unref = () => {};

const app = render(createElement(App, { cwd, initialMode: "chat" }), { stdout, stdin, debug: true, patchConsole: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const viewerScreen = () => screen.replace(/\n$/, "").split("\n").slice(0, ROWS);

const KEYS = { left: "\u001b[D", right: "\u001b[C", down: "\u001b[B", enter: "\r", esc: "\u001b" };
/** Viewer screens after each step of the key script. */
const viewer = [];
async function shot(duration, keys = [], settle = 700) {
  for (const k of keys) {
    stdin.write(KEYS[k] ?? k);
    await sleep(120);
  }
  await sleep(settle);
  viewer.push({ lines: viewerScreen(), duration });
}

await sleep(1500);
await shot(2500); // newest turn, following the session
await shot(3500, ["g"]); // first turn: plan with list and table
await shot(3000, Array(14).fill("down")); // scroll to the C# block
await shot(1800, [" "]); // mark the turn
await shot(3500, ["2"], 1800); // changes view: diff of OrderService.cs
await shot(3000, ["enter"], 1000); // whole file after the change
await shot(3000, ["esc", "right"], 1000); // next file
await shot(2000, ["1"]); // back to the chat

app.unmount();
rmSync(root, { recursive: true, force: true });

// Windows Terminal draws the border of the focused pane in its accent color.
const BORDER = "\u001b[38;2;97;175;239m│\u001b[0m";
const split = (rightLines) => {
  const left = claudeScreen({ width: LEFT, rows: ROWS, ran: true });
  return left.map((line, i) => line + BORDER + (rightLines[i] ?? ""));
};
const full = (input, ran = false) => claudeScreen({ width: COLUMNS, rows: ROWS, input, ran });

const COMMAND = "/cco:chat";
const frames = [{ lines: full(""), duration: 1800 }];
for (let i = 1; i <= COMMAND.length; i++) frames.push({ lines: full(COMMAND.slice(0, i)), duration: i === 1 ? 700 : 110 });
frames.push({ lines: full(COMMAND), duration: 1200 });
frames.push({ lines: full("", true), duration: 600 });
for (const shot of viewer) frames.push({ lines: split(shot.lines), duration: shot.duration });

const docs = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
mkdirSync(docs, { recursive: true });
writeFileSync(join(docs, "demo.svg"), framesToSvg(frames, { columns: COLUMNS, rows: ROWS, title: TITLE }));
const still = { columns: RIGHT, rows: ROWS, title: "cco" };
writeFileSync(join(docs, "chat.svg"), frameToSvg(viewer[2].lines, still));
writeFileSync(join(docs, "changes.svg"), frameToSvg(viewer[4].lines, still));
console.log(`Wrote ${frames.length} frames to docs/demo.svg, plus docs/chat.svg and docs/changes.svg`);
process.exit(0);
