import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROFILE_SCOPE, readToken, RemoteError, SESSIONS_SCOPE } from "../src/remote/credentials.js";
import { parseUsage, quotaOf, quotaSource, readQuotaFile, refreshQuota } from "../src/remote/quota.js";
import { TIMING } from "../src/timing.js";
import { quotaLines, resetTime } from "../src/tui/quotaLines.js";
import stripAnsi from "strip-ansi";

/** An answer of /api/oauth/usage as claude.ai sent it (trimmed). */
const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "oauth-usage.json"), "utf8")) as Record<string, unknown>;
const NOW = Date.parse("2026-11-09T08:36:00Z");

describe("the account's usage from claude.ai", () => {
  it("takes the 5-hour and 7-day windows, as a share and in Unix seconds", () => {
    expect(parseUsage(recorded, NOW)).toEqual({
      fiveHour: { utilization: 0.62, resetsAt: Math.floor(Date.parse("2026-11-09T10:50:00.159Z") / 1000) },
      sevenDay: { utilization: 0.24, resetsAt: Math.floor(Date.parse("2026-11-11T15:00:00.159Z") / 1000) },
      seen: new Date(NOW).toISOString(),
    });
  });

  it("takes a window not started yet without a time, and none for null", () => {
    expect(parseUsage({ five_hour: { utilization: 0, resets_at: null }, seven_day: null }, NOW)).toEqual({ fiveHour: { utilization: 0 }, seen: new Date(NOW).toISOString() });
  });

  it("calls any other shape a format error", () => {
    for (const raw of [{}, { five_hour: null }, { five_hour: { utilization: "62" }, seven_day: null }, { five_hour: { utilization: 1, resets_at: "soon" }, seven_day: null }, []]) {
      expect(() => parseUsage(raw, NOW)).toThrow(RemoteError);
    }
  });

  it("needs a login with the profile scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-quota-login-"));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: NOW + 60_000, scopes: [SESSIONS_SCOPE] } }));
    expect(() => readToken(dir, NOW, PROFILE_SCOPE)).toThrow(/user:profile/);
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: NOW + 60_000, scopes: [PROFILE_SCOPE] } }));
    expect(readToken(dir, NOW, PROFILE_SCOPE)).toBe("t");
    expect(() => readToken(dir, NOW + 120_000, PROFILE_SCOPE)).toThrow(/expired/);
  });
});

describe("the reads shared by the viewers of an account", () => {
  const realGet = quotaSource.get;
  let dir: string;
  let calls: number;
  let answer: () => Promise<unknown>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cco-quota-"));
    calls = 0;
    answer = async () => recorded;
    quotaSource.get = () => {
      calls++;
      return answer();
    };
  });
  afterEach(() => {
    quotaSource.get = realGet;
  });
  afterAll(() => {
    quotaSource.get = realGet;
  });

  it("asks claude.ai only when the last read is due, also for another viewer", async () => {
    const first = await refreshQuota(dir, NOW);
    expect(calls).toBe(1);
    expect(first).toMatchObject({ fetchedAt: NOW, nextAt: NOW + TIMING.quotaPoll, failures: 0 });
    // Another viewer of the account reads the file instead.
    await refreshQuota(dir, NOW + 10);
    expect(calls).toBe(1);
    await refreshQuota(dir, NOW + TIMING.quotaPoll);
    expect(calls).toBe(2);
    // F5 asks at once.
    await refreshQuota(dir, NOW + TIMING.quotaPoll + 10, true);
    expect(calls).toBe(3);
  });

  it("claims a read before it asks, so a viewer starting meanwhile waits for it", async () => {
    let release!: () => void;
    answer = () => new Promise((resolve) => (release = () => resolve(recorded)));
    const running = refreshQuota(dir, NOW);
    expect(readQuotaFile(dir)?.nextAt).toBe(NOW + TIMING.quotaPoll);
    await refreshQuota(dir, NOW + 5);
    expect(calls).toBe(1);
    release();
    await running;
  });

  it("waits longer after each failure and keeps the windows read before", async () => {
    await refreshQuota(dir, NOW);
    answer = async () => {
      throw new RemoteError("rate-limit", "claude.ai asks to slow down");
    };
    const failed = await refreshQuota(dir, NOW + TIMING.quotaPoll);
    expect(failed).toMatchObject({ failures: 1, nextAt: NOW + 3 * TIMING.quotaPoll, error: { kind: "rate-limit" }, fetchedAt: NOW });
    expect(failed.limits?.fiveHour?.utilization).toBe(0.62);
    const again = await refreshQuota(dir, NOW + 3 * TIMING.quotaPoll);
    expect(again).toMatchObject({ failures: 2, nextAt: NOW + 7 * TIMING.quotaPoll });
    // A read that works again clears the failure.
    answer = async () => recorded;
    expect(await refreshQuota(dir, NOW + 7 * TIMING.quotaPoll)).toEqual(expect.not.objectContaining({ error: expect.anything() }));
  });
});

describe("what a viewer shows of the windows", () => {
  const limits = parseUsage(recorded, NOW);

  it("is the newer of the read and the remote sessions' reports, current while recent", () => {
    const file = { limits, fetchedAt: NOW, nextAt: NOW + TIMING.quotaPoll, failures: 0 };
    expect(quotaOf(file, undefined, NOW + 1000)).toEqual({ limits, stale: false, seenAt: NOW });
    const reported = { fiveHour: { utilization: 0.7, resetsAt: limits.fiveHour!.resetsAt }, seen: new Date(NOW + 500).toISOString() };
    expect(quotaOf(file, reported, NOW + 1000).limits).toEqual({ fiveHour: reported.fiveHour, sevenDay: limits.sevenDay, seen: reported.seen });
  });

  it("dims old windows with why they are old, and drops them once the 5-hour window started anew", () => {
    const file = { limits, fetchedAt: NOW, nextAt: 0, failures: 3, error: { kind: "expired" as const, message: "the login has expired" } };
    const old = quotaOf(file, undefined, NOW + 30 * 60_000);
    expect(old).toMatchObject({ limits, stale: true, error: "the login has expired" });
    const after = quotaOf(file, undefined, limits.fiveHour!.resetsAt! * 1000 + 1);
    expect(after.limits).toBeUndefined();
    expect(after.stale).toBe(true);
  });

  it("previews each window with a bar, the percentage and when it starts anew", () => {
    const now = NOW + 1000;
    const lines = quotaLines({ limits, stale: false, seenAt: NOW, refresh: () => {} }, (t) => [t], now).map(stripAnsi);
    expect(lines[1]).toMatch(/^5 hours {2}█{6}░{4} {3}62 % {2}resets \d\d:\d\d \(in 2h13m\)$/);
    expect(lines[2]).toMatch(/^7 days {3}█{2}░{8} {3}24 % {2}resets \w{3} \d\d:\d\d \(in 2d6h\)$/);
    expect(lines).toContain("as of just now");
    expect(quotaLines({ stale: false, reason: "off", refresh: () => {} }, (t) => [t]).join(" ")).toContain("remote API");
    expect(quotaLines({ stale: false, reason: "api", refresh: () => {} }, (t) => [t]).join(" ")).toContain("API profile");
  });

  it("names the time of a reset by the clock, the weekday beyond today", () => {
    const now = new Date(2026, 10, 9, 8, 0).getTime();
    expect(resetTime(new Date(2026, 10, 9, 16, 40).getTime() / 1000, now)).toBe("16:40");
    expect(resetTime(new Date(2026, 10, 12, 9, 0).getTime() / 1000, now)).toBe("Thu 09:00");
  });
});
