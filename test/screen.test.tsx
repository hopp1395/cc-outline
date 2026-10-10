import chalk from "chalk";
import { Text } from "ink";
import { describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { AccountBadgeContext, Screen, type Layout } from "../src/tui/layout.js";
import { VERSION } from "../src/version.js";

async function topBar(columns: number, status: string): Promise<string> {
  const layout: Layout = { columns, rows: 10, listWidth: 20, previewWidth: columns - 23, bodyHeight: 8 };
  const app = renderInk(<Screen layout={layout} mode="chat" status={<Text>{status}</Text>} list={null} preview={null} footer="" />, layout, {
    interactive: true,
  });
  // The version appears in the frame after the first layout.
  await new Promise((resolve) => setTimeout(resolve, 50));
  app.unmount();
  return app.frame().split("\n")[0]!;
}

describe("Screen top bar", () => {
  it("shows the version on the right when there is room", async () => {
    const line = await topBar(160, "3 prompts");
    expect(line).toContain("3 prompts");
    expect(line.trimEnd().endsWith(`v${VERSION}`)).toBe(true);
    expect(line.length).toBeLessThanOrEqual(160);
  });

  it("leaves the version out rather than cutting the status", async () => {
    const tabs = "cco  1 Chat  2 Changes  3 Plan  4 Sessions  5 Monitor  6 Settings  ".length;
    const status = "x".repeat(160 - tabs - 3);
    const line = await topBar(160, status);
    expect(line).toContain(status);
    expect(line).not.toContain(`v${VERSION}`);
  });

  it("shows the version again once the status is short enough", async () => {
    const tabs = "cco  1 Chat  2 Changes  3 Plan  4 Sessions  5 Monitor  6 Settings  ".length;
    const status = "x".repeat(160 - tabs - ` v${VERSION} `.length);
    expect(await topBar(160, status)).toContain(`${status} v${VERSION}`);
  });

  it("still truncates a bar that is too wide", async () => {
    expect(await topBar(60, "3 prompts")).toBe("cco  1 Chat  2 Changes  3 Plan  4 Sessions  5 Monitor  6 Se…");
  });

  it("draws the cco lead on the account's colour, and leaves it alone without one", async () => {
    const layout: Layout = { columns: 100, rows: 10, listWidth: 20, previewWidth: 77, bodyHeight: 8 };
    const bar = async (badge: string | undefined) => {
      const app = renderInk(
        <AccountBadgeContext.Provider value={badge}>
          <Screen layout={layout} mode="chat" status={<Text>x</Text>} list={null} preview={null} footer="" />
        </AccountBadgeContext.Provider>,
        layout,
        { interactive: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      app.unmount();
      return app.raw().split("\n")[0]!;
    };
    // Tests run without colours; 48;2;r;g;b is a truecolor background: #0f766e.
    const level = chalk.level;
    chalk.level = 3;
    try {
      expect(await bar("#0f766e")).toContain("48;2;15;118;110m");
      expect(await bar(undefined)).not.toContain("48;2;15;118;110m");
    } finally {
      chalk.level = level;
    }
  });
});
