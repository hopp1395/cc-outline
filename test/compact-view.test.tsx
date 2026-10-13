import { Text } from "ink";
import { afterAll, describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { DEFAULT_SETTINGS, readSettings, updateSettings } from "../src/settings.js";
import { layoutOf, Screen, tabAt } from "../src/tui/layout.js";
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
    const list = layoutOf(70, 30, "normal", false, true);
    expect(list).toMatchObject({ fold: "full", listWidth: 70, compact: true });
    expect(layoutOf(70, 30, "wider", true, true)).toMatchObject({ fold: "hidden", previewWidth: 69 });
  });

  it("gains the help line's row and keeps previews' headers to a line and the rule", () => {
    expect(layoutOf(70, 30, "normal", false, false).bodyHeight).toBe(28);
    const compact = layoutOf(70, 30, "normal", false, true);
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
    const layout = layoutOf(80, 12, "normal", false, true);
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
