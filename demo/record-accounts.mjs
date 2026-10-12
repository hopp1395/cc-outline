// Records docs/accounts.gif: the Accounts view and the Sessions view of a demo with three Claude accounts. The
// real viewer runs headlessly on the demo project (as for demo.gif) while a key script plays. Run with
// `npm run demo:accounts` (builds demo/.out/App.js first); the GIF needs Chrome or Edge.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { frameSize, frameToSvg } from "./ansi-svg.mjs";
import { createAccounts, createDemo } from "./fixture.mjs";
import { writeGif } from "./gif.mjs";

const COLUMNS = 110;
const ROWS = 30;

const root = mkdtempSync(join(tmpdir(), "cco-demo-"));
const { cwd, configDir } = createDemo(root);
const bin = createAccounts(root, configDir);
// Must be set before the viewer is imported: it reads transcripts, settings and the accounts from here.
process.env.CLAUDE_CONFIG_DIR = configDir;
// The demo folder stands in for the home folder, where the accounts are looked for (~\.claude-work, not a temp path).
const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, PATH: process.env.PATH };
process.env.USERPROFILE = process.env.HOME = root;
// The start scripts go next to claude: here the demo's ~/.local/bin.
process.env.PATH = [bin, process.env.PATH].join(delimiter);
process.env.WT_SESSION = "demo";
delete process.env.TMUX;
globalThis.fetch = () => Promise.reject(new Error("no network in the demo"));

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

const app = render(createElement(App, { cwd, initialMode: "accounts" }), { stdout, stdin, debug: true, patchConsole: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const viewerScreen = () => screen.replace(/\n$/, "").split("\n").slice(0, ROWS);

const KEYS = { up: "\u001b[A", down: "\u001b[B", end: "\u001b[F", enter: "\r", esc: "\u001b" };
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
await shot(3000); // the active account and its details
await shot(3500, ["down"]); // another account: plugin, sessions of this project
await shot(4000, ["enter"]); // its menu: continue here, new session, folder, the danger zone
await shot(1200, ["esc"]);
await shot(3000, ["d"]); // move it to the trash: what moves
await shot(1500, ["enter"]); // the second question: type its folder name
await shot(2500, [".claude-work"]);
await shot(1200, ["esc"]);
await shot(4000, ["end"]); // how to add an account
await shot(3000, ["enter", "cw2"]); // Enter sets one up: command and folder
await shot(1200, ["esc"]);
await shot(3000, ["4", "a"], 1800); // Sessions with the other accounts' sessions, a bar in each account's colour
await shot(3500, ["down"]); // a session of another account: its account in the header
await shot(4000, ["enter"]); // what can be done with it
await shot(1500, ["esc"]);

app.unmount();
// Chrome (for the GIF) needs the real profile folder and PATH.
Object.assign(process.env, saved);
rmSync(root, { recursive: true, force: true });

// The frames as plain text, to check the script without opening the GIF.
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/g, "");
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), ".out", "accounts.txt"), frames.map((f, i) => `--- ${i}\n${f.lines.map(plain).join("\n")}`).join("\n"));

const docs = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
mkdirSync(docs, { recursive: true });
const window = { columns: COLUMNS, rows: ROWS, title: "cco" };
writeGif(
  frames.map((f) => ({ svg: frameToSvg(f.lines, window), duration: f.duration })),
  frameSize(COLUMNS, ROWS),
  join(docs, "accounts.gif"),
);
console.log(`Wrote docs/accounts.gif (${frames.length} frames)`);
process.exit(0);
