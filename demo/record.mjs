// Records the README demo: runs the viewer headlessly on a demo project,
// plays a key script and writes the frames to docs/ as SVG.
// Run with `npm run demo` (builds demo/.out/App.js first).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { framesToSvg, frameToSvg } from "./ansi-svg.mjs";
import { createDemo } from "./fixture.mjs";

const COLUMNS = 118;
const ROWS = 30;
const TITLE = "cco — Claude Code session and changes";

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
stdout.columns = COLUMNS;
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
const lastFrame = () => screen.replace(/\n$/, "").split("\n").slice(0, ROWS);

const KEYS = { left: "\u001b[D", right: "\u001b[C", down: "\u001b[B", enter: "\r", esc: "\u001b" };
const frames = [];
async function shot(duration, keys = [], settle = 700) {
  for (const k of keys) {
    stdin.write(KEYS[k] ?? k);
    await sleep(120);
  }
  await sleep(settle);
  frames.push({ lines: lastFrame(), duration });
}

await sleep(1500);
await shot(2200); // newest turn, following the session
await shot(3500, ["g"]); // first turn: plan with list and table
await shot(3000, Array(14).fill("down")); // scroll to the C# block
await shot(1800, [" "]); // mark the turn
await shot(3500, ["2"], 1800); // changes view: diff of OrderService.cs
await shot(3000, ["enter"], 1000); // whole file after the change
await shot(3000, ["esc", "right"], 1000); // next file
await shot(2000, ["1"]); // back to the chat

app.unmount();
rmSync(root, { recursive: true, force: true });

const docs = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
mkdirSync(docs, { recursive: true });
const size = { columns: COLUMNS, rows: ROWS, title: TITLE };
writeFileSync(join(docs, "demo.svg"), framesToSvg(frames, size));
writeFileSync(join(docs, "chat.svg"), frameToSvg(frames[2].lines, size));
writeFileSync(join(docs, "changes.svg"), frameToSvg(frames[4].lines, size));
console.log(`Wrote ${frames.length} frames to docs/demo.svg, docs/chat.svg and docs/changes.svg`);
process.exit(0);
