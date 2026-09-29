import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Text, render } from "ink";
import stripAnsi from "strip-ansi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateSettings } from "../src/settings.js";
import { dayLabel, dayOf, entryGroups, linesByDay, separatorsAt, separatorText } from "../src/tui/days.js";
import { AreaContext, List, listRows } from "../src/tui/layout.js";

/** An ISO timestamp at a local time in September 2026. */
const at = (day: number, hour = 9) => new Date(2026, 8, day, hour).toISOString();
const now = new Date(2026, 8, 29, 12).getTime();

// The List reads the dateSeparators setting: from a settings file of its own, not the user's.
let saved: string | undefined;
beforeAll(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-days-"));
});
afterAll(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("entryGroups", () => {
  it("gives no days when everything is from today", () => {
    expect(entryGroups(["2026-09-29", undefined, "2026-09-29"], "day", now)).toBeUndefined();
    expect(entryGroups([undefined], "day", now)).toBeUndefined();
  });

  it("names a single day that is not today", () => {
    expect(entryGroups(["2026-09-27", "2026-09-27"], "day", now)).toEqual(["2026-09-27", "2026-09-27"]);
  });

  it("gives entries without a day the one before, at the start the first one", () => {
    expect(entryGroups([undefined, "2026-09-28", undefined, "2026-09-29", undefined], "day", now)).toEqual([
      "2026-09-28",
      "2026-09-28",
      "2026-09-28",
      "2026-09-29",
      "2026-09-29",
    ]);
  });
});

describe("year groups", () => {
  it("gives none when all entries are from this year", () => {
    expect(entryGroups(["2026", "2026"], "year", now)).toBeUndefined();
    expect(entryGroups(["2026", "2025"], "year", now)).toEqual(["2026", "2025"]);
  });

  it("names the year in the separator", () => {
    expect(separatorText("2025", 12)).toBe("── 2025 ────");
  });

  it("takes a day key as it is, not as UTC midnight", () => {
    expect(dayOf("2026-01-01")).toBe("2026-01-01");
  });
});

describe("separatorsAt", () => {
  it("announces each day before its first entry", () => {
    expect(separatorsAt(["a", "a", "b", "b", "c"])).toEqual(["a", undefined, "b", undefined, "c"]);
    expect(separatorsAt(undefined)).toEqual([]);
  });
});

describe("dayLabel", () => {
  it("adds the year only for another year", () => {
    expect(dayLabel("2026-09-28", "other", now)).toBe("Mon 28 Sep");
    expect(dayLabel("2025-12-31", "other", now)).toBe("Wed 31 Dec 2025");
    expect(dayLabel("2026-09-28", "always", now)).toBe("Mon 28 Sep 2026");
  });

  it("draws the separator with the year across the width", () => {
    expect(separatorText("2026-09-28", 24)).toBe("── Mon 28 Sep 2026 ─────");
  });
});

describe("listRows", () => {
  it("puts a separator row above each group", () => {
    expect(listRows(3, ["a", "a", "b"])).toEqual([
      { group: "a", before: 0 },
      { item: 0 },
      { item: 1 },
      { group: "b", before: 2 },
      { item: 2 },
    ]);
    expect(listRows(2, undefined)).toEqual([{ item: 0 }, { item: 1 }]);
  });
});

describe("linesByDay", () => {
  it("indents the separators like the entries", () => {
    const lines = linesByDay([at(27), at(28), at(28, 10)], (t) => t, (t) => `  ${new Date(t).getHours()}`, 21).map(stripAnsi);
    expect(lines).toEqual(["  ── Sun 27 Sep 2026 ", "  9", "  ── Mon 28 Sep 2026 ", "  9", "  10"]);
  });
});

async function listOutput(
  items: { id: string; ts?: string }[],
  opts: { selected: number; height: number; reversed?: boolean; period?: "day" | "year"; shown?: number[] },
) {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 30, rows: opts.height });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let output = "";
  stdout.on("data", (chunk) => {
    const frame = stripAnsi(String(chunk));
    if (frame) output = frame;
  });
  const app = render(
    <AreaContext.Provider value={{ x: 0, y: 0, width: 20, height: opts.height }}>
      <List
        items={items}
        selected={opts.selected}
        height={opts.height}
        empty="none"
        itemKey={(i) => i.id}
        time={(i) => i.ts}
        reversed={opts.reversed}
        period={opts.period}
        shown={opts.shown}
        render={(i) => <Text>{i.id}</Text>}
      />
    </AreaContext.Provider>,
    { stdout: stdout as never, stdin: stdin as never, debug: true, patchConsole: false, interactive: true },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  app.unmount();
  return output.split("\n").map((l) => l.trimEnd());
}

describe("List with times", () => {
  const items = [
    { id: "a", ts: at(27) },
    { id: "b", ts: at(27, 10) },
    { id: "c" },
    { id: "d", ts: at(28) },
  ];

  it("shows a separator above each day, an entry without time joining the day before", async () => {
    const lines = await listOutput(items, { selected: 0, height: 10 });
    expect(lines.slice(0, 6)).toEqual(["── Sun 27 Sep 2026 ─", "a", "b", "c", "── Mon 28 Sep 2026 ─", "d"]);
  });

  it("keeps the separator above its group when reversed", async () => {
    const lines = await listOutput(items, { selected: 0, height: 10, reversed: true });
    expect(lines.slice(0, 6)).toEqual(["── Mon 28 Sep 2026 ─", "d", "── Sun 27 Sep 2026 ─", "c", "b", "a"]);
  });

  it("names the first shown entry's day in the ▲ row", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, ts: at(20 + Math.floor(i / 4)) }));
    const lines = await listOutput(many, { selected: 6, height: 4 });
    expect(lines[0]).toMatch(/^ ▲ 5 more · Mon 21 Sep {2}Home$/);
    expect(lines.slice(1, 3)).toEqual(["e5", "e6"]);
  });

  it("groups days by year with period year (Monitor)", async () => {
    const days = [{ id: "2026-01-02", ts: "2026-01-02" }, { id: "2025-12-31", ts: "2025-12-31" }, { id: "2025-12-30", ts: "2025-12-30" }];
    const lines = await listOutput(days, { selected: 0, height: 10, period: "year" });
    expect(lines.slice(0, 5)).toEqual(["── 2026 ────────────", "2026-01-02", "── 2025 ────────────", "2025-12-31", "2025-12-30"]);
  });

  it("shows only a filter's entries, with the separators of their days, also reversed", async () => {
    expect((await listOutput(items, { selected: 3, height: 10, shown: [1, 3] })).slice(0, 4)).toEqual([
      "── Sun 27 Sep 2026 ─",
      "b",
      "── Mon 28 Sep 2026 ─",
      "d",
    ]);
    expect((await listOutput(items, { selected: 1, height: 10, shown: [0, 1], reversed: true })).slice(0, 3)).toEqual([
      "── Sun 27 Sep 2026 ─",
      "b",
      "a",
    ]);
  });

  it("shows no separators with the setting off", async () => {
    updateSettings({ dateSeparators: false });
    try {
      expect((await listOutput(items, { selected: 0, height: 10 })).slice(0, 4)).toEqual(["a", "b", "c", "d"]);
    } finally {
      updateSettings({ dateSeparators: true });
    }
  });
});
