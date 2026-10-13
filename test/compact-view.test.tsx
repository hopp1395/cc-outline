import { Text } from "ink";
import { afterAll, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { DEFAULT_SETTINGS, readSettings, updateSettings } from "../src/settings.js";
import { AreaContext, layoutOf, List, Screen, stackedLayout, tabAt } from "../src/tui/layout.js";
import { detailFold, UNFOLDED } from "../src/tui/listFold.js";

afterAll(() => updateSettings({ compactView: "off" }));

describe("compact view", () => {
  it("is off by default and ignores unknown values", () => {
    expect(DEFAULT_SETTINGS.compactView).toBe("off");
    updateSettings({ compactView: "sideways" as never });
    expect(readSettings().compactView).toBe("off");
    updateSettings({ compactView: "single" });
    expect(readSettings().compactView).toBe("single");
  });

  it("shows the list over the whole pane, whatever width is stored, and the preview when drilled", () => {
    const list = layoutOf(70, 30, "normal", false, "single");
    expect(list).toMatchObject({ fold: "full", listWidth: 70, compact: true });
    expect(layoutOf(70, 30, "wider", true, "single")).toMatchObject({ fold: "hidden", previewWidth: 69 });
  });

  it("gains the help line's row and keeps previews' headers to a line and the rule", () => {
    expect(layoutOf(70, 30, "normal", false, "off").bodyHeight).toBe(28);
    const compact = layoutOf(70, 30, "normal", false, "single");
    expect(compact.bodyHeight).toBe(29);
    expect(compact.headerHeight).toBe(4);
  });

  it("opens a detail over the pane from the list like a full width does", () => {
    expect(detailFold("full", UNFOLDED, true, false).drilled).toBe(true);
  });

  it("shortens the tabs but the open one, and tabAt measures them alike", () => {
    updateSettings({ compactView: "single" });
    const settings = readSettings();
    // "cco" lead and a space, then " 1 Chat " (open) and " 2 " " 3 " …
    const lead = "cco".length;
    expect(tabAt(lead + 1 + 1, settings, "chat")).toBe("chat");
    const afterChat = lead + 1 + " 1 Chat ".length;
    expect(tabAt(afterChat + 1, settings, "chat")).toBe("git");
    expect(tabAt(afterChat + " 2 ".length + 1, settings, "chat")).toBe("plan");
  });

  it("leaves out the help line, the status and the version", async () => {
    updateSettings({ compactView: "single" });
    const layout = layoutOf(80, 12, "normal", false, "single");
    const app = renderInk(
      <Screen layout={layout} mode="git" status={<Text>3 files</Text>} list={<Text>list</Text>} preview={null} footer="FOOTER-HELP" />,
      layout,
      { interactive: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    app.unmount();
    const frame = app.frame();
    expect(frame).toContain("2 Changes");
    expect(frame).not.toContain("3 Plan");
    expect(frame).not.toContain("FOOTER-HELP");
    expect(frame).not.toContain("3 files");
    expect(frame).not.toMatch(/v\d+\.\d+\.\d+/);
  });
});

describe("compact view stacked", () => {
  it("shares the rows below the top bar between list, a rule and preview", () => {
    const third = stackedLayout(80, 31, "1", "1/3");
    // 30 rows: 10 for the list, 1 for the rule, 19 for the preview.
    expect(third).toMatchObject({ listHeight: 10, bodyHeight: 19, listColumns: 1, listWidth: 80, previewWidth: 79, stacked: true });
    expect(third.listHeight! + 1 + third.bodyHeight).toBe(30);
    expect(stackedLayout(80, 31, "1", "1/2").listHeight).toBe(15);
    expect(stackedLayout(80, 31, "1", "1/4").listHeight).toBe(8);
  });

  it("splits the width between the columns, one column between them", () => {
    const two = stackedLayout(81, 31, "2", "1/3");
    expect(two.listColumns).toBe(2);
    expect(two.listWidth * 2 + 1).toBeLessThanOrEqual(81);
    expect(stackedLayout(80, 31, "4", "1/3").listWidth).toBe(19);
  });

  it("keeps a few rows for the list and the preview in a low pane", () => {
    const low = stackedLayout(80, 8, "1", "1/2");
    expect(low.listHeight).toBeGreaterThanOrEqual(3);
    expect(low.bodyHeight).toBeGreaterThanOrEqual(3);
  });

  it("fills the columns one after the other and selects through them in order", async () => {
    const items = Array.from({ length: 7 }, (_, i) => `entry ${i}`);
    const list = (selected: number) => (
      <AreaContext.Provider value={{ x: 0, y: 0, width: 31, height: 4, columns: 2 }}>
        <List items={items} selected={selected} height={4} empty="–" itemKey={(s) => s} render={(s) => <Text>{s}</Text>} />
      </AreaContext.Provider>
    );
    const app = renderInk(list(0), { columns: 40, rows: 8 });
    await new Promise((r) => setTimeout(r, 50));
    const lines = app.frame().split("\n");
    // The first column holds entries 0–3, the second 4–6.
    expect(lines[0]).toMatch(/^entry 0 +│entry 4/);
    expect(lines[2]).toMatch(/^entry 2 +│entry 6/);
    expect(lines[3]).toMatch(/^entry 3 +│/);
    expect(lines[3]).not.toContain("entry 7");
    app.unmount();
  });

  it("shows the list above the preview with the rule between", async () => {
    updateSettings({ compactView: "stacked" });
    const layout = stackedLayout(40, 12, "1", "1/3");
    const app = renderInk(
      <Screen layout={layout} mode="git" status={null} list={<Text>LIST</Text>} preview={<Text>PREVIEW</Text>} footer="FOOTER" />,
      layout,
      { interactive: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    app.unmount();
    const lines = app.frame().split("\n");
    const at = (text: string) => lines.findIndex((l) => l.includes(text));
    expect(at("LIST")).toBe(1);
    expect(lines[1 + layout.listHeight!]).toMatch(/^─+$/);
    expect(at("PREVIEW")).toBe(2 + layout.listHeight!);
    expect(at("FOOTER")).toBe(-1);
  });
});
