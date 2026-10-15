// Records docs/compact.gif: the compact view for small screens, in a narrow pane. The real viewer runs headlessly on
// the demo project (as for demo.gif) while a key script plays: the stacked layout with the list's columns changed
// by < and >, then the Changes and Sessions views, then the single column. Run with `npm run demo:compact`
// (builds demo/.out/App.js first); the GIF needs Chrome or Edge.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { frameSize, frameToSvg } from "./ansi-svg.mjs";
import { createDemo } from "./fixture.mjs";
import { writeGif } from "./gif.mjs";

const COLUMNS = 64;
const ROWS = 26;

const root = mkdtempSync(join(tmpdir(), "cco-demo-"));
const { cwd, configDir } = createDemo(root);
// Must be set before the viewer is imported: it reads transcripts and settings from here.
process.env.CLAUDE_CONFIG_DIR = configDir;
const home = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
process.env.USERPROFILE = process.env.HOME = root;
process.env.WT_SESSION = "demo";
// The images show English, whatever language the machine runs in (setting language: system).
process.env.LC_ALL = "en_US.UTF-8";
delete process.env.TMUX;
globalThis.fetch = () => Promise.reject(new Error("no network in the demo"));
// The demo starts in the stacked layout; the single column is chosen in the Settings view.
mkdirSync(join(configDir, "cco"), { recursive: true });
writeFileSync(join(configDir, "cco", "settings.json"), JSON.stringify({ compactView: "stacked" }));

const { render } = await import("ink");
const { createElement } = await import("react");
const { App } = await import("./.out/App.js");

const stdout = new PassThrough();
stdout.columns = COLUMNS;
stdout.rows = ROWS;
stdout.isTTY = true;
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

const KEYS = { up: "\u001b[A", down: "\u001b[B", ctrlDown: "\u001b[1;5B", enter: "\r", esc: "\u001b", ctrlF: "\u0006" };
const frames = [];
/** Presses `keys` (a key name or text typed character by character), then keeps the screen for `duration` ms. */
async function shot(duration, keys = [], settle = 700) {
  for (const k of keys) {
    for (const ch of KEYS[k] ? [KEYS[k]] : [...k]) {
      stdin.write(ch);
      await sleep(KEYS[k] ? 120 : 90);
    }
  }
  await sleep(settle);
  frames.push({ lines: viewerScreen(), duration });
}

await sleep(1500);
await shot(3000); // the chat: two columns of turns above the answer
await shot(3000, ["g"]); // the first turn
await shot(3000, [...Array(6).fill("ctrlDown")]); // scroll its answer
await shot(2500, [">"], 2200); // three columns, after the notice is gone
await shot(2500, ["<", "<"], 2200); // one column
await shot(2500, [">"], 2200); // two columns again
await shot(3000, [">", "2"], 1500); // Changes: the files above the diff
await shot(3000, ["down"], 1000);
await shot(3000, ["4"], 1800); // Sessions
await shot(3500, ["6", "ctrlF", "compact", "enter"], 1500); // Settings: the compact settings
await shot(3500, ["enter", "enter"], 1500); // off, then single: one column
await shot(3000, ["1"], 1500); // the chat as a single column: the list
await shot(3500, ["enter"], 1500); // Enter shows the full prompt over the whole pane
await shot(2500, ["esc"], 1000); // Esc goes back to the list
await shot(3500, ["|"], 1200); // | swaps list and preview

app.unmount();
// Chrome (for the GIF) needs the real profile folder.
Object.assign(process.env, home);
rmSync(root, { recursive: true, force: true });

// The frames as plain text, to check the script without opening the GIF.
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/g, "");
mkdirSync(join(dirname(fileURLToPath(import.meta.url)), ".out"), { recursive: true });
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), ".out", "compact.txt"), frames.map((f, i) => `--- ${i}\n${f.lines.map(plain).join("\n")}`).join("\n"));

const docs = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
mkdirSync(docs, { recursive: true });
const window = { columns: COLUMNS, rows: ROWS, title: "cco" };
writeGif(
  frames.map((f) => ({ svg: frameToSvg(f.lines, window), duration: f.duration })),
  frameSize(COLUMNS, ROWS),
  join(docs, "compact.gif"),
);
console.log(`Wrote docs/compact.gif (${frames.length} frames)`);
process.exit(0);
