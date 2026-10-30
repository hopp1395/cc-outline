import chalk from "chalk";
import { Text } from "ink";
import { describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import type { AccountColorName } from "../src/account.js";
import { AccountAvatarContext, AccountBadgeContext, DevContext, Screen, type Layout } from "../src/tui/layout.js";
import { MouseContext } from "../src/tui/mouse.js";
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
    const bar = async (badge: AccountColorName | undefined) => {
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
    // Tests run without colours; with them, magentaBright is background 105, with black text (30) readable on it.
    const level = chalk.level;
    chalk.level = 3;
    try {
      const lead = await bar("magentaBright");
      expect(lead).toContain("105m");
      expect(lead).toContain("30m");
      expect(await bar("red")).toContain("41m");
      expect(await bar(undefined)).not.toMatch(/\u001b\[(4[0-7]|10[0-7])m/);
    } finally {
      chalk.level = level;
    }
  });

  it("shows the account's avatar in place of the cco, the tabs moved along", async () => {
    const layout: Layout = { columns: 100, rows: 10, listWidth: 20, previewWidth: 77, bodyHeight: 8 };
    const bar = async (avatar: string | undefined) => {
      const app = renderInk(
        <AccountAvatarContext.Provider value={avatar}>
          <Screen layout={layout} mode="chat" status={<Text>x</Text>} list={null} preview={null} footer="" />
        </AccountAvatarContext.Provider>,
        layout,
        { interactive: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      app.unmount();
      return app.frame().split("\n")[0]!;
    };
    expect(await bar("🦊")).toMatch(/^ 🦊   1 Chat/);
    expect(await bar("👾👾👾")).toMatch(/^ 👾👾👾   1 Chat/);
    expect(await bar(undefined)).toMatch(/^cco  1 Chat/);
  });

  it("ends in DEV for a cco run from a checkout, also where the status is cut, and a click on it calls for the switch", async () => {
    const layout: Layout = { columns: 60, rows: 10, listWidth: 20, previewWidth: 37, bodyHeight: 8 };
    let clicked = 0;
    const app = renderInk(
      <MouseContext.Provider value={true}>
        <DevContext.Provider value={() => clicked++}>
          <Screen layout={layout} mode="chat" status={<Text>{"x".repeat(80)}</Text>} list={null} preview={null} footer="" />
        </DevContext.Provider>
      </MouseContext.Provider>,
      layout,
      { interactive: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const line = app.frame().split("\n")[0]!;
    expect(line.trimEnd().endsWith("… DEV")).toBe(true);
    expect(line).not.toContain(`v${VERSION}`);
    // The tabs give way, not DEV.
    await app.click(30, 1);
    expect(clicked).toBe(0);
    await app.click(58, 1);
    await expect.poll(() => clicked).toBe(1);
    app.unmount();
  });

  it("shows no DEV for an installed cco", async () => {
    expect(await topBar(160, "3 prompts")).not.toContain("DEV");
  });
});
