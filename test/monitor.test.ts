import { describe, expect, it } from "vitest";
import { barChart, bucketMinutes } from "../src/monitor/chart.js";
import {
  bucketScores,
  dayBuckets,
  dayKey,
  dayScore,
  daysWithData,
  modelsByRecency,
  ResponseReader,
  scoreOf,
  typicalBuckets,
  type Bucket,
  type Measurements,
  type Response,
} from "../src/monitor/responses.js";

const line = (e: object) => JSON.stringify(e) + "\n";
/** Local time on 2026-09-27 (or `day`), as the transcripts' ISO timestamps. */
const at = (hhmmss: string, day = "2026-09-27") => new Date(`${day}T${hhmmss}`).toISOString();
const user = (t: string, extra = {}) => line({ type: "user", timestamp: at(t), message: { role: "user", content: "x" }, ...extra });
const assistant = (t: string, id: string, tokens: number, extra = {}) =>
  line({ type: "assistant", timestamp: at(t), message: { id, model: "claude-opus-5-5", usage: { output_tokens: tokens }, content: [] }, ...extra });

describe("ResponseReader", () => {
  it("times each response from the entry before it to its last line", () => {
    const r = new ResponseReader("unused");
    r.push(user("10:00:00") + assistant("10:00:04", "m1", 10) + assistant("10:00:20", "m1", 1000) + user("10:00:21") + assistant("10:00:31", "m2", 500));
    expect(r.responses).toEqual([
      { start: Date.parse(at("10:00:00")), first: Date.parse(at("10:00:04")), end: Date.parse(at("10:00:20")), model: "claude-opus-5-5", outputTokens: 1000 },
      { start: Date.parse(at("10:00:21")), first: Date.parse(at("10:00:31")), end: Date.parse(at("10:00:31")), model: "claude-opus-5-5", outputTokens: 500 },
    ]);
  });

  it("keeps subagent lines apart, skips made-up messages and collects errors", () => {
    const r = new ResponseReader("unused");
    r.push(
      user("10:00:00") +
        user("10:00:05", { isSidechain: true }) +
        assistant("10:00:10", "side", 100, { isSidechain: true }) +
        assistant("10:00:30", "main", 100) +
        line({ type: "assistant", timestamp: at("10:00:40"), message: { id: "s", model: "<synthetic>", content: [] } }) +
        line({ type: "assistant", timestamp: at("10:01:00"), isApiErrorMessage: true, message: { content: [{ type: "text", text: "Limit reached · wait\nmore" }] } }),
    );
    const byId = Object.fromEntries(r.responses.map((x) => [x.first, x.start]));
    // The subagent's response starts at its own prompt, the main one at the main prompt.
    expect(byId[Date.parse(at("10:00:10"))]).toBe(Date.parse(at("10:00:05")));
    expect(byId[Date.parse(at("10:00:30"))]).toBe(Date.parse(at("10:00:00")));
    expect(r.responses).toHaveLength(2);
    expect(r.errors).toEqual([{ at: Date.parse(at("10:01:00")), text: "Limit reached · wait" }]);
  });
});

describe("buckets", () => {
  const resp = (time: string, secs: number, tokens: number, model = "claude-opus-5-5", day = "2026-09-27"): Response => {
    const start = Date.parse(at(time, day));
    return { start, first: start + 2000, end: start + secs * 1000, model, outputTokens: tokens };
  };
  const data: Measurements = {
    responses: [
      resp("10:05:00", 10, 1000), // 100 tok/s
      resp("10:10:00", 10, 500), // 50 tok/s
      resp("10:20:00", 10, 10), // too few tokens to time, still counted
      resp("23:50:00", 10, 900, "claude-sonnet-5"),
      resp("10:00:00", 10, 800, "claude-opus-5-5", "2026-09-26"),
    ],
    errors: [{ at: Date.parse(at("10:12:00")), text: "limit" }],
  };

  it("takes medians per stretch of the selected day and model", () => {
    const b = dayBuckets(data, "2026-09-27", 60, "claude-opus-5-5");
    expect(b).toHaveLength(24);
    expect(b[10]).toMatchObject({ speed: 75, wait: 2, count: 3 });
    expect(b[10].errors).toHaveLength(1);
    expect(b[23].count).toBe(0);
    expect(dayBuckets(data, "2026-09-27", 60)[23].count).toBe(1);
  });

  it("compares with the days before, per time of day", () => {
    expect(typicalBuckets(data, "2026-09-27", 60, "claude-opus-5-5")[10]).toMatchObject({ speed: 80, count: 1 });
  });

  it("counts the timed responses per stretch", () => {
    expect(dayBuckets(data, "2026-09-27", 60, "claude-opus-5-5")[10]).toMatchObject({ count: 3, measured: 2 });
  });

  it("lists days newest first with today leading, and models by recency", () => {
    const now = Date.parse(at("12:00:00", "2026-09-28"));
    expect(daysWithData(data, undefined, now).map((d) => [d.day, d.count, d.errors])).toEqual([
      ["2026-09-28", 0, 0],
      ["2026-09-27", 4, 1],
      ["2026-09-26", 1, 0],
    ]);
    expect(modelsByRecency(data)).toEqual(["claude-sonnet-5", "claude-opus-5-5"]);
    expect(dayKey(Date.parse(at("23:59:00")))).toBe("2026-09-27");
  });
});

describe("overall index", () => {
  it("is 100 for usual values and weighs speed and wait alike", () => {
    expect(scoreOf({ speed: 80, wait: 2 }, { speed: 80, wait: 2 })).toBe(100);
    // Twice as fast and twice the wait cancel out.
    expect(scoreOf({ speed: 160, wait: 4 }, { speed: 80, wait: 2 })).toBeCloseTo(100);
    expect(scoreOf({ speed: 160, wait: 1 }, { speed: 80, wait: 2 })).toBeCloseTo(200);
  });

  it("uses what there is to compare", () => {
    expect(scoreOf({ speed: 40 }, { speed: 80, wait: 2 })).toBeCloseTo(50);
    expect(scoreOf({ speed: 40, wait: 1 }, {})).toBeUndefined();
    expect(scoreOf({ speed: 40, wait: 0 }, { wait: 2 })).toBeUndefined();
  });

  it("weighs a day's stretches by their timed responses", () => {
    const bucket = (speed: number, measured: number): Bucket => ({ speed, measured, count: measured, errors: [] });
    const usual = [bucket(100, 1), bucket(100, 1), bucket(100, 1)];
    expect(bucketScores([bucket(200, 1), bucket(50, 3), bucket(0, 0)], usual)).toEqual([200, 50, undefined]);
    // (ln 2 + 3 ln 0.5) / 4 = ln 0.5 / 2
    expect(dayScore([bucket(200, 1), bucket(50, 3), bucket(0, 0)], usual)).toBeCloseTo(100 * Math.SQRT1_2);
    expect(dayScore([bucket(0, 0)], usual)).toBeUndefined();
  });
});

describe("barChart", () => {
  const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

  it("fits a whole day into the width", () => {
    expect(bucketMinutes(300)).toBe(5);
    expect(bucketMinutes(96)).toBe(15);
    expect(bucketMinutes(80)).toBe(20);
    expect(bucketMinutes(30)).toBe(60);
  });

  it("draws bars in eighths, the usual value, empty stretches and errors", () => {
    const lines = barChart([100, 50, undefined, 1], {
      height: 2,
      minutes: 360,
      reference: [undefined, undefined, 75, undefined],
      errors: [false, true, false, false],
      format: (v) => v.toFixed(0),
    }).map(strip);
    expect(lines).toEqual([
      " 100┤█ ─ ",
      "   0┼██ ▁",
      "    └┬✗┬─",
      "     00",
    ]);
  });
});
