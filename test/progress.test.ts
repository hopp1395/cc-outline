import { describe, expect, it } from "vitest";
import { currentStep, progressText, type ProgressStep } from "../src/tui/ProgressDialog.js";
import { exportProgress, PAIR_TIMEOUT_MS, pairingProgress } from "../src/tui/SessionsView.js";
import { checkProgress } from "../src/tui/SettingsView.js";

const noop = () => {};

describe("progress text", () => {
  it("writes a running step as Verb – step (n/m)…, an ended run as its outcome", () => {
    expect(progressText({ title: "t", status: "running", text: "Updating", step: { label: "CLI", at: 1, of: 3 } })).toBe("Updating – CLI (1/3)…");
    expect(progressText({ title: "t", status: "running", text: "Importing" })).toBe("Importing…");
    expect(progressText({ title: "t", status: "waiting", text: "Restarting" })).toBe("Restarting…");
    expect(progressText({ title: "t", status: "done", text: "Exported 2 sessions", step: { label: "x" } })).toBe("Exported 2 sessions");
    expect(progressText(checkProgress({ current: "Settings" }))).toBe("Checking – Settings (3/5)…");
  });

  it("takes the step running, else the first that failed, else the last that ran", () => {
    const step = (label: string, status: ProgressStep["status"]): ProgressStep => ({ label, status, output: "" });
    expect(currentStep([step("a", "done"), step("b", "running"), step("c", "pending")])).toEqual({ label: "b", at: 2, of: 3 });
    expect(currentStep([step("a", "failed"), step("b", "done")])).toEqual({ label: "a", at: 1, of: 2 });
    expect(currentStep([step("a", "done"), step("b", "pending")])).toEqual({ label: "a", at: 1, of: 2 });
    expect(currentStep([step("a", "pending")])).toBeUndefined();
  });
});

describe("export progress", () => {
  it("keeps its title and counts the steps of each session", () => {
    expect(progressText(exportProgress(2, {}))).toBe("Exporting…");
    const running = exportProgress(2, { progress: { session: 2, sessions: 2, step: "json" }, title: "Fix login" });
    expect(running.title).toBe("Export 2 sessions");
    expect(progressText(running)).toBe("Exporting – json (4/5)…");
    expect(running.detail).toBe("session 2 of 2: Fix login");
    expect(exportProgress(1, { progress: { session: 1, sessions: 1, step: "reading" }, title: "Fix login" }).detail).toBe("Fix login");
    const done = exportProgress(2, { result: { file: "/tmp/cco-session-export.zip", sessions: 2 } });
    expect([done.title, done.status, done.text]).toEqual(["Export 2 sessions", "done", "Exported 2 sessions"]);
    const failed = exportProgress(2, { error: new Error("disk full") });
    expect([failed.title, failed.status, failed.text, failed.lines]).toEqual(["Export 2 sessions", "failed", "Nothing was written", ["disk full"]]);
  });
});

describe("pairing progress", () => {
  const pairing = { sessionId: "s1", cwd: "/p", transcript: "/p/s1.jsonl", started: 1000 };

  it("starts, then waits with the time counted, and can be cancelled meanwhile", () => {
    const starting = pairingProgress(pairing, 1000, noop, noop);
    expect(progressText(starting)).toBe("Starting Claude Code…");
    expect(starting.onCancel).toBeDefined();
    const waiting = pairingProgress({ ...pairing, where: "w" }, 13_500, noop, noop);
    expect(waiting.title).toBe("Attach the viewer");
    expect(progressText(waiting)).toBe("Waiting for Claude Code…");
    expect(waiting.detail).toMatch(new RegExp(`^12 of ${PAIR_TIMEOUT_MS / 1000} s`));
    expect(waiting.onCancel).toBeDefined();
  });

  it("stays with the reason when Claude Code did not show up", () => {
    const failed = pairingProgress({ ...pairing, where: "w", failed: { text: "Claude Code did not show up within 30 s", lines: ["x"] } }, 99_000, noop, noop);
    expect([failed.status, failed.text, failed.lines]).toEqual(["failed", "Claude Code did not show up within 30 s", ["x"]]);
    expect(failed.onClose).toBeDefined();
  });
});
