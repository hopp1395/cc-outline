import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { TIMING } from "../src/timing.js";

// Tests point CLAUDE_CONFIG_DIR at a folder of their own and restore it afterwards; without a value to
// restore, Node would set the string "undefined", and a late write would land in ./undefined of the checkout.
process.env.CLAUDE_CONFIG_DIR ||= mkdtempSync(join(tmpdir(), "cco-tests-"));

// The viewer asks npm and GitHub at its start (setting updateMode); tests stay offline.
vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));

// Tests wait for these timers in real time: shorter, but long enough to see each state with expect.poll.
Object.assign(TIMING, {
  restartDelay: 200,
  checkStep: 0,
  activityPoll: 100,
  pairPoll: 50,
  blink: 100,
  reloaded: 300,
  tailStat: 100,
} satisfies typeof TIMING);
