import { describe, expect, it } from "vitest";
import type { RemoteUsage } from "../src/remote/usage.js";
import { SessionComposer, type PromptChannel } from "../src/tui/SessionComposer.js";
import type { Layout } from "../src/tui/layout.js";
import { renderInk } from "./helpers/ink.js";

const layoutOf = (columns: number): Layout => ({ columns, rows: 24, listWidth: 0, previewWidth: columns, bodyHeight: 24 });
const channel: PromptChannel = { send: async () => {}, interrupt: async () => {} };
const at = (s: number) => Date.now() / 1000 + s;
const usage: RemoteUsage = {
  context: 62_400,
  limits: { fiveHour: { utilization: 0.23, resetsAt: at(2 * 3600 + 14 * 60 + 30) }, sevenDay: { utilization: 0.97, resetsAt: at(3 * 86400 + 4 * 3600 + 30) }, seen: "" },
};

const rows = (columns: number, extra: { usage?: RemoteUsage; blocked?: string } = {}) => {
  const layout = layoutOf(columns);
  const view = renderInk(
    <SessionComposer layout={layout} channel={{ ...channel, blocked: extra.blocked }} title="t" working={false} focused={false} onFocus={() => {}} notify={() => {}} onHeight={() => {}} usage={extra.usage} />,
    layout,
  );
  const lines = view.frame().split("\n").filter((l) => l.trim());
  view.unmount();
  return lines;
};

describe("the prompt line's frame", () => {
  it("is open to the sides, a line above and below, the text from the first column", () => {
    const lines = rows(40);
    expect(lines[0]).toBe("─".repeat(40));
    expect(lines[1]).toMatch(/^›/);
    expect(lines[2]).toMatch(/^Tab write a prompt/);
    expect(lines.at(-1)).toBe("─".repeat(40));
    expect(lines.join("\n")).not.toMatch(/[╭╮╰╯│]/);
  });

  it("carries the usage at the right of its bottom line", () => {
    const lines = rows(60, { usage });
    expect(lines[0]).toBe("─".repeat(60));
    expect(lines[1]).toMatch(/^›/);
    expect(lines.at(-1)).toBe(`${"─".repeat(20)} Ctx 62k · 5h 23% 2h14m · 7d 97% 3d4h ──`);
  });

  it("shortens the usage on a narrow pane, also while the line is blocked", () => {
    expect(rows(32, { usage }).at(-1)).toBe(`${"─".repeat(3)} Ctx 62k · 5h 23% · 7d 97% ──`);
    expect(rows(22, { usage, blocked: "steer remote is off" }).at(-1)).toBe(`${"─".repeat(3)} 5h 23% · 7d 97% ──`);
    expect(rows(12, { usage }).at(-1)).toBe(`${"─".repeat(2)} 5h 23% ──`);
    expect(rows(11, { usage }).at(-1)).toBe("─".repeat(11));
  });
});
