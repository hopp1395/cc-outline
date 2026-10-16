// Records docs/rc-viewer.gif: the Remote Control Viewer watching sessions on this machine and on another one. The real
// viewer runs headlessly while a key script plays: sessions of this machine stand in with Claude Code processes that
// only idle (node), the Remote Control sessions come from a claude.ai that answers in this script. Nothing is typed into
// a real Claude Code. Run with `npm run demo:rc-viewer` (builds demo/.out/rc-viewer-entry.js first); the GIF needs
// Chrome or Edge.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { frameSize, frameToSvg } from "./ansi-svg.mjs";
import { createDemo } from "./fixture.mjs";
import { writeGif } from "./gif.mjs";

const COLUMNS = 120;
const ROWS = 32;
const MINUTE = 60_000;

const root = mkdtempSync(join(tmpdir(), "cco-demo-"));
const { cwd: shop, configDir } = createDemo(root);
const docs = join(root, "docs-site");
mkdirSync(docs, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = configDir;
const home = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
process.env.USERPROFILE = process.env.HOME = root;
process.env.WT_SESSION = "demo";
delete process.env.TMUX;

// Signed in with claude.ai, remote API and steering on.
writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "demo", expiresAt: Date.now() + 3_600_000, scopes: ["user:sessions:claude_code"] } }));
writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "jan@example.com", organizationUuid: "org-demo" } }));
writeFileSync(join(configDir, "cco", "settings.json"), JSON.stringify({ sessionsRange: "all", monitorRange: "all", remoteApi: true, remoteControl: true, rcViewerSessionsWidth: "wide" }));

const slug = (path) => path.replace(/[^a-zA-Z0-9]/g, "-");
const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * MINUTE).toISOString();

/** A transcript of this machine: a prompt and Claude's answer `minutesAgo`, written then. */
function localSession(id, cwd, title, minutesAgo, prompt, answer, extra = []) {
  const dir = join(configDir, "projects", slug(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const at = iso(minutesAgo);
  const lines = [
    { type: "user", uuid: `${id}-u`, timestamp: at, cwd, gitBranch: "main", sessionId: id, message: { role: "user", content: prompt } },
    { type: "assistant", uuid: `${id}-a`, timestamp: at, cwd, sessionId: id, message: { id: `${id}-m`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: answer }], stop_reason: "end_turn", usage: { input_tokens: 1200, output_tokens: 300 } } },
    { type: "custom-title", customTitle: title, sessionId: id },
    ...extra,
  ];
  writeFileSync(file, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const when = new Date(now - minutesAgo * MINUTE);
  utimesSync(file, when, when);
  return file;
}

// Claude Code processes: one node that idles per session, so their pids are alive.
const claudes = [];
function runs(sessionId, cwd, status) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
  claudes.push(child);
  const sessions = join(configDir, "sessions");
  mkdirSync(sessions, { recursive: true });
  const write = (s) => writeFileSync(join(sessions, `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId, status: s, cwd }));
  write(status);
  return write;
}

localSession(
  "a1b2c3d4-0000-4000-8000-000000000001",
  shop,
  "flaky-tests",
  6,
  "OrderRepositoryTests fail every few runs, find out why",
  "The test reads `DateTime.Now` twice; across midnight the dates differ. Two ways to fix it, I'll ask which you prefer.",
);
runs("a1b2c3d4-0000-4000-8000-000000000001", shop, "waiting");
localSession(
  "a1b2c3d4-0000-4000-8000-000000000002",
  shop,
  "checkout-refactor",
  1,
  "Split CheckoutService into payment and shipping",
  "Extracting `PaymentGateway` now, then `ShippingCalculator`. The public API stays as it is.",
);
runs("a1b2c3d4-0000-4000-8000-000000000002", shop, "busy");
localSession(
  "a1b2c3d4-0000-4000-8000-000000000003",
  docs,
  "docs-update",
  2,
  "Document the new order validation rules",
  "Writing `docs/orders.md` with the three rules and an example for each.",
);
const docsStatus = runs("a1b2c3d4-0000-4000-8000-000000000003", docs, "busy");
// Connected to claude.ai with Remote Control: its permission is read and answered there.
localSession(
  "a1b2c3d4-0000-4000-8000-000000000004",
  shop,
  "release-notes",
  3,
  "Prepare the 2.4 release and check the package",
  "The changelog is written. Before publishing I'd like to check what goes into the package.",
  [{ type: "bridge-session", sessionId: "a1b2c3d4-0000-4000-8000-000000000004", bridgeSessionId: "cse_demo_release" }],
);
const releaseStatus = runs("a1b2c3d4-0000-4000-8000-000000000004", shop, "waiting");
// The demo's own session (order-validation) ended a little earlier today.
const ended = join(configDir, "projects", slug(shop));
for (const name of ["7f3c2a91-5d4e-4b8a-9c61-0e2f8d4a6b13.jsonl"]) {
  try {
    const when = new Date(now - 25 * MINUTE);
    utimesSync(join(ended, name), when, when);
  } catch {
    // The fixture names its session differently: then it stays out of today's list.
  }
}

// Ink's colours, also when this script's own output is no terminal (chalk would leave them out).
process.env.FORCE_COLOR ||= "3";
const { render } = await import("ink");
const { createElement } = await import("react");
const { RcViewerApp, setOwnSettings, recordLocalRequest } = await import("./.out/rc-viewer-entry.js");

// What flaky-tests asks, as its hooks record it.
recordLocalRequest({
  hook_event_name: "PreToolUse",
  session_id: "a1b2c3d4-0000-4000-8000-000000000001",
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [
      {
        question: "How should the test get its time?",
        header: "Clock",
        multiSelect: false,
        options: [
          { label: "Inject a clock", description: "OrderRepository takes an IClock" },
          { label: "Freeze the time in the test", description: "only the test changes" },
        ],
      },
    ],
  },
});

// claude.ai: two sessions on another machine, and the Remote Control twin of release-notes.
let seq = 0;
const event = (source, payload, minutesAgo = 0) => ({ sequence_num: String(++seq), event_id: `e${seq}`, event_type: payload.type, source, created_at: iso(minutesAgo), payload });
const user = (text, minutesAgo) => event("client", { type: "user", uuid: `u${seq + 1}`, message: { role: "user", content: text } }, minutesAgo);
const claude = (text, minutesAgo) =>
  event("worker", { type: "assistant", uuid: `a${seq + 1}`, message: { id: `m${seq + 1}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: "end_turn" } }, minutesAgo);
const remoteSessions = {
  cse_demo_gateway: {
    entry: { id: "cse_demo_gateway", title: "api-gateway", status: "active", worker_status: "running", connection_status: "connected", environment_kind: "bridge", created_at: iso(40), last_event_at: iso(1) },
    events: [user("Add rate limiting to the public endpoints", 12), claude("Adding a token bucket per API key; 100 requests a minute by default.", 11)],
  },
  cse_demo_report: {
    entry: { id: "cse_demo_report", title: "nightly-report", status: "active", worker_status: "idle", connection_status: "connected", environment_kind: "bridge", created_at: iso(90), last_event_at: iso(8) },
    events: [user("Summarise last night's build failures", 9), claude("Three failures, all in `PaymentTests`: a timeout against the sandbox. The report is in `reports/nightly.md`.", 8)],
  },
  cse_demo_release: {
    entry: {
      id: "cse_demo_release",
      title: "release-notes",
      status: "active",
      worker_status: "requires_action",
      connection_status: "connected",
      environment_kind: "bridge",
      created_at: iso(20),
      last_event_at: iso(3),
      external_metadata: { pending_action: { request_id: "req-publish", tool_name: "Bash", display_tool_name: "Bash", tool_use_id: "toolu_publish", input: { command: "npm publish --dry-run" }, action_description: "Lists what the package would contain" } },
    },
    events: [],
  },
};
remoteSessions.cse_demo_release.events.push(
  event("worker", { type: "control_request", request_id: "req-publish", request: { subtype: "can_use_tool", tool_name: "Bash", display_name: "Bash", input: { command: "npm publish --dry-run" }, tool_use_id: "toolu_publish" } }, 3),
);
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
globalThis.fetch = async (url, init = {}) => {
  const match = /\/sessions\/([^/?]+)\/events/.exec(url);
  if (init.method === "POST" && match) {
    const s = remoteSessions[match[1]];
    const payload = JSON.parse(String(init.body)).events[0].payload;
    if (payload.type === "control_response") {
      // Allowed: Claude goes on, here and in its terminal.
      s.events.push(event("client", payload));
      s.entry = { ...s.entry, worker_status: "running", external_metadata: {} };
      releaseStatus("busy");
    } else if (payload.type === "user") {
      s.events.push(event("client", payload));
      s.entry = { ...s.entry, worker_status: "running", last_event_at: iso(0) };
      setTimeout(() => {
        s.events.push(claude("Yesterday's error rate was 0.4% (12 of 3,104 requests); added it to the summary table.", 0));
        s.entry = { ...s.entry, worker_status: "idle", last_event_at: iso(0) };
      }, 2500);
    }
    return json({});
  }
  if (match) return json({ data: [...remoteSessions[match[1]].events].reverse() });
  if (url.includes("/sessions")) return json({ data: Object.values(remoteSessions).map((s) => s.entry) });
  return Promise.reject(new Error("no network in the demo"));
};

setOwnSettings("rcViewer");
const stdout = new PassThrough();
stdout.columns = COLUMNS;
stdout.rows = ROWS;
stdout.isTTY = true;
let screen = "";
// A frame of Ink's, not the window title the viewer sets on its own (OSC only).
stdout.on("data", (d) => {
  const text = String(d);
  if (!/^(\u001b\][^\u0007]*\u0007)+$/.test(text)) screen = text;
});
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.ref = () => {};
stdin.unref = () => {};

const app = render(createElement(RcViewerApp, {}), { stdout, stdin, debug: true, patchConsole: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const viewerScreen = () => screen.replace(/\n$/, "").split("\n").slice(0, ROWS);
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/g, "");
const shown = (text) => viewerScreen().some((l) => plain(l).includes(text));

const KEYS = { up: "\u001b[A", down: "\u001b[B", left: "\u001b[D", right: "\u001b[C", enter: "\r", esc: "\u001b", space: " ", tab: "\t" };
const frames = [];
/** Presses `keys` (a key name or text typed character by character), then keeps the screen for `duration` ms. */
async function shot(duration, keys = [], settle = 700) {
  for (const k of keys) {
    for (const ch of KEYS[k] ? [KEYS[k]] : [...k]) {
      stdin.write(ch);
      await sleep(KEYS[k] ? 150 : 60);
    }
  }
  await sleep(settle);
  frames.push({ lines: viewerScreen(), duration });
}
/** A few short frames in a row, so the blinking marks show. */
async function blink(count = 4) {
  for (let i = 0; i < count; i++) await shot(500, [], 500);
}
/** Moves the selection down the sessions list until `text` shows (the selected session's chat). */
async function selectShowing(text) {
  for (let i = 0; i < 12 && !shown(text); i++) {
    stdin.write(KEYS.down);
    await sleep(500);
  }
}

await sleep(3500);
await shot(3500); // every session, grouped: flaky-tests waits, its question in the prompt line's place
await blink(); // ⚠ blinks, working ● dims
await shot(3500, ["n"], 1500); // n: release-notes, connected to claude.ai (⇄), wants to run a command
await shot(2500, ["space"], 800); // Space: the permission panel has the keys
await shot(3000, ["enter"], 1800); // Allow: answered through claude.ai, Claude goes on
await shot(1200, ["tab"], 600); // Tab: the keys back to the chat (Esc would stop Claude now)
docsStatus("idle"); // docs-update finishes meanwhile
await sleep(1500);
await blink(); // its ● blinks until it is seen
await shot(3000, ["n", "n"], 1500); // n: the waiting one, then the one that just finished
await shot(3500, ["enter"], 1200); // Enter: what to do with it
await shot(1500, ["esc"], 800);
await selectShowing("Three failures"); // nightly-report, on another machine
await shot(3000, [], 800);
await shot(3500, ["space", "Add yesterday's error rate"], 1000); // a prompt to the other machine
await shot(2500, ["enter"], 1500); // sent; Claude works there
await sleep(3000);
await shot(4000, [], 1000); // its answer arrives in the chat

app.unmount();
for (const c of claudes) c.kill();
Object.assign(process.env, home);
rmSync(root, { recursive: true, force: true });

mkdirSync(join(dirname(fileURLToPath(import.meta.url)), ".out"), { recursive: true });
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), ".out", "rc-viewer.txt"), frames.map((f, i) => `--- ${i}\n${f.lines.map(plain).join("\n")}`).join("\n"));

const docsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
mkdirSync(docsDir, { recursive: true });
const window = { columns: COLUMNS, rows: ROWS, title: "cco rc-viewer" };
writeGif(
  frames.map((f) => ({ svg: frameToSvg(f.lines, window), duration: f.duration })),
  frameSize(COLUMNS, ROWS),
  join(docsDir, "rc-viewer.gif"),
);
console.log(`Wrote docs/rc-viewer.gif (${frames.length} frames)`);
process.exit(0);
