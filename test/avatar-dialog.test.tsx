import { Box } from "ink";
import { describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { AvatarDialog } from "../src/tui/AvatarDialog.js";
import type { Layout } from "../src/tui/layout.js";

const layout: Layout = { columns: 80, rows: 50, listWidth: 30, previewWidth: 48, bodyHeight: 46 };
const UP = "\u001b[A";
const DOWN = "\u001b[B";

function dialog(value: string) {
  const saved: string[] = [];
  let cancelled = false;
  const view = renderInk(
    <Box width={layout.columns} height={layout.rows}>
      <AvatarDialog layout={layout} value={value} onSave={(a) => saved.push(a)} onCancel={() => (cancelled = true)} />
    </Box>,
    layout,
  );
  return { view, saved, cancelled: () => cancelled };
}

describe("the avatar dialog", () => {
  it("lists the presets by group, each with what it shows, and how to type emojis", async () => {
    const { view } = dialog("");
    await expect.poll(view.frame).toContain("Avatar in the top bar");
    const frame = view.frame();
    for (const text of ["Default", "ASCII", "Emoji", "Combos", "cco", "(^_^)", "happy", "🦊", "fox", "☕💻", "coder", "👾👾👾", "space invaders"]) expect(frame).toContain(text);
    expect(frame).toMatch(/Win\+\.|Ctrl\+Cmd\+Space|emoji picker/);
    view.unmount();
  });

  it("takes the preset chosen with the arrows, and the default as empty", async () => {
    const { view, saved } = dialog("");
    await expect.poll(view.frame).toContain("Avatar in the top bar");
    await view.press(DOWN);
    await view.press("\r");
    await expect.poll(() => saved).toEqual(["(^_^)"]);
    view.unmount();
    const again = dialog("(^_^)");
    await expect.poll(again.view.frame).toContain("Avatar in the top bar");
    await again.view.press(UP);
    await again.view.press("\r");
    await expect.poll(() => again.saved).toEqual([""]);
    again.view.unmount();
  });

  it("puts what is typed into the field and refuses one too wide", async () => {
    const { view, saved } = dialog("");
    await expect.poll(view.frame).toContain("Avatar in the top bar");
    await view.press("toolong");
    await view.press("\r");
    await expect.poll(view.frame).toContain("at most 6 columns");
    expect(saved).toEqual([]);
    await view.press("\u0015");
    await view.press(" JH ");
    await view.press("\r");
    await expect.poll(() => saved).toEqual(["JH"]);
    view.unmount();
  });

  it("opens with one's own avatar in the field, and Esc cancels", async () => {
    const { view, saved, cancelled } = dialog("JH");
    await expect.poll(view.frame).toContain("› JH");
    await view.press("\u001b");
    await expect.poll(cancelled).toBe(true);
    expect(saved).toEqual([]);
    view.unmount();
  });
});
