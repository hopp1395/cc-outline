// Records the README demo: Claude Code (a simplified stand-in) runs /cco:chat,
// the window splits, and the real viewer runs headlessly on a demo project in
// the right pane while a key script plays. Writes docs/demo.gif and stills of
// the three views as SVG. Run with `npm run demo` (builds demo/.out/App.js first);
// the GIF needs Chrome or Edge.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { frameSize, frameToSvg } from "./ansi-svg.mjs";
import { claudeScreen } from "./claude-mock.mjs";
import { createDemo } from "./fixture.mjs";
import { writeGif } from "./gif.mjs";

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
// Paths under the home directory are shown with ~; the demo folder stands in for it (~\shop, not a temp path).
const home = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
process.env.USERPROFILE = process.env.HOME = root;
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
await shot(3000, [...Array(14).fill("down"), "right", "left"]); // scroll to the C# block; the turn switch restarts the list marquee
await shot(1800, [" "]); // mark the turn
await shot(3500, ["2"], 1800); // changes view: diff of OrderService.cs
await shot(3000, ["enter"], 1000); // whole file after the change
await shot(3000, ["esc", "right"], 1000); // next file
await shot(3500, ["3"], 1000); // plan view: the approved second version
await shot(3000, ["enter"], 1000); // changes to the rejected first version
await shot(2500, ["esc", "4"], 1800); // sessions view: all projects, the active session selected
await shot(4000, ["left", "left", "left"], 1000); // an older session with plans and changed files
await shot(2000, ["1"]); // back to the chat

app.unmount();
// Chrome (for the GIF) needs the real profile folder.
Object.assign(process.env, home);
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
const still = { columns: RIGHT, rows: ROWS, title: "cco" };
writeFileSync(join(docs, "chat.svg"), frameToSvg(viewer[2].lines, still));
writeFileSync(join(docs, "changes.svg"), frameToSvg(viewer[4].lines, still));
writeFileSync(join(docs, "plan.svg"), frameToSvg(viewer[7].lines, still));
writeFileSync(join(docs, "sessions.svg"), frameToSvg(viewer[10].lines, still));
const window = { columns: COLUMNS, rows: ROWS, title: TITLE };
writeGif(
  frames.map((f) => ({ svg: frameToSvg(f.lines, window), duration: f.duration })),
  frameSize(COLUMNS, ROWS),
  join(docs, "demo.gif"),
);
console.log(`Wrote docs/demo.gif (${frames.length} frames), docs/chat.svg, docs/changes.svg, docs/plan.svg and docs/sessions.svg`);
process.exit(0);
