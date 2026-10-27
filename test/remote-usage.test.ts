import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RemoteEvent } from "../src/remote/api.js";
import { contextOf, fitUsage, keepRateLimits, newerLimits, rateLimitsOf, readRateLimits, shortTokens, untilReset, usageParts, usageWidth, type UsagePart } from "../src/remote/usage.js";

/** The events of the two recordings from the Claude app, as `listEvents` gives them. */
function recorded(name: string): RemoteEvent[] {
  return readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> })
    .filter((c) => c.kind === "event")
    .map(({ data: e }) => ({ sequence: Number(e.sequence_num), createdAt: e.created_at as string, source: e.source as string, payload: e.payload as Record<string, unknown> }))
    .sort((a, b) => a.sequence - b.sequence);
}

const capture = recorded("remote-capture.jsonl");
const permissions = recorded("remote-permissions.jsonl");

describe("the usage of a remote session", () => {
  it("takes both windows from the newest rate_limit_event", () => {
    expect(rateLimitsOf(capture)).toMatchObject({ fiveHour: { utilization: 0.23, resetsAt: 1792018800 }, sevenDay: { utilization: 0.97, resetsAt: 1792346400 } });
    const limits = rateLimitsOf(permissions)!;
    expect(limits.fiveHour!.utilization).toBe(0.27);
    expect(limits.seen).toBe(permissions.filter((e) => e.payload.type === "rate_limit_event").at(-1)!.createdAt);
    expect(rateLimitsOf(capture.filter((e) => e.payload.type !== "rate_limit_event"))).toBeUndefined();
  });

  it("takes the window that triggered an event without unifiedWindows", () => {
    const event: RemoteEvent = { sequence: 1, createdAt: "2026-10-27T10:00:00Z", source: "worker", payload: { type: "rate_limit_event", rate_limit_info: { rateLimitType: "five_hour", utilization: 0.5, resetsAt: 100 } } };
    expect(rateLimitsOf([event])).toEqual({ fiveHour: { utilization: 0.5, resetsAt: 100 }, seen: "2026-10-27T10:00:00Z" });
  });

  it("reads the context of the last answer of the main conversation, skipping empty ones and subagents", () => {
    const answer = (sequence: number, usage: Record<string, number>, extra: Record<string, unknown> = {}): RemoteEvent => ({
      sequence,
      createdAt: "",
      source: "worker",
      payload: { type: "assistant", message: { usage }, ...extra },
    });
    const events = [
      answer(1, { input_tokens: 2, cache_read_input_tokens: 30301, cache_creation_input_tokens: 16967 }),
      answer(2, { input_tokens: 9, cache_read_input_tokens: 90000 }, { parent_tool_use_id: "toolu_1" }),
      answer(3, { input_tokens: 0, output_tokens: 0 }),
    ];
    expect(contextOf(events)).toBe(47270);
    expect(contextOf(capture)).toBeGreaterThan(0);
    expect(contextOf([])).toBeUndefined();
  });

  it("keeps the newer of each window", () => {
    const old = { fiveHour: { utilization: 0.1, resetsAt: 1 }, sevenDay: { utilization: 0.2, resetsAt: 2 }, seen: "2026-10-27T09:00:00Z" };
    const recent = { fiveHour: { utilization: 0.3, resetsAt: 3 }, seen: "2026-10-27T10:00:00Z" };
    expect(newerLimits(old, recent)).toEqual({ fiveHour: recent.fiveHour, sevenDay: old.sevenDay, seen: recent.seen });
    expect(newerLimits(recent, old)).toEqual({ fiveHour: recent.fiveHour, sevenDay: old.sevenDay, seen: recent.seen });
    expect(newerLimits(undefined, recent)).toBe(recent);
  });

  it("shows the context and the windows with the time left, – once a window started anew", () => {
    const now = 1_000_000_000_000;
    const at = (s: number) => now / 1000 + s;
    const parts = usageParts({ context: 62_400, limits: { fiveHour: { utilization: 0.23, resetsAt: at(2 * 3600 + 14 * 60) }, sevenDay: { utilization: 0.97, resetsAt: at(3 * 86400 + 4 * 3600) }, seen: "" } }, now);
    expect(parts).toEqual([
      { label: "Ctx", value: "62k" },
      { label: "5h", value: "23%", level: "low", rest: "2h14m" },
      { label: "7d", value: "97%", level: "high", rest: "3d4h" },
    ]);
    expect(usageParts({ limits: { fiveHour: { utilization: 0.6, resetsAt: at(-5) }, seen: "" } }, now)).toEqual([{ label: "5h", value: "–" }]);
    expect(usageParts({}, now)).toEqual([]);
    expect(shortTokens(950)).toBe("950");
    expect(shortTokens(1_000_000)).toBe("1M");
    expect(shortTokens(1_250_000)).toBe("1.3M");
    expect(untilReset(at(540), now)).toBe("9m");
  });

  it("shortens to fit: without the times left, then without Ctx, then 5h alone", () => {
    const parts: UsagePart[] = [
      { label: "Ctx", value: "62k" },
      { label: "5h", value: "23%", level: "low", rest: "2h14m" },
      { label: "7d", value: "97%", level: "high", rest: "3d4h" },
    ];
    const labels = (room: number) => fitUsage(parts, room).map((p) => `${p.label} ${p.value}${p.rest ? ` ${p.rest}` : ""}`);
    expect(usageWidth(parts)).toBe(36);
    expect(labels(36)).toEqual(["Ctx 62k", "5h 23% 2h14m", "7d 97% 3d4h"]);
    expect(labels(35)).toEqual(["Ctx 62k", "5h 23%", "7d 97%"]);
    expect(labels(24)).toEqual(["5h 23%", "7d 97%"]);
    expect(labels(14)).toEqual(["5h 23%"]);
    expect(labels(5)).toEqual([]);
    expect(fitUsage([{ label: "Ctx", value: "62k" }], 5)).toEqual([]);
  });
});

describe("the windows kept for the account", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-rate-limits-"));
  });
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it("are the newest any viewer read", () => {
    const recent = { sevenDay: { utilization: 0.5, resetsAt: 10 }, seen: "2026-10-27T10:00:00Z" };
    expect(keepRateLimits(recent)).toEqual(recent);
    expect(readRateLimits()).toEqual(recent);
    // An older report of another session changes nothing; none at all gives what is kept.
    expect(keepRateLimits({ sevenDay: { utilization: 0.1, resetsAt: 5 }, seen: "2026-10-27T08:00:00Z" })).toEqual(recent);
    expect(keepRateLimits(undefined)).toEqual(recent);
  });
});
