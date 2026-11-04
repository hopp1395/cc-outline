import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Turn } from "../src/transcript/parse.js";
import { moveRow } from "../src/tui/PromptDialog.js";
import { promptHistory, SessionComposer, type PromptChannel } from "../src/tui/SessionComposer.js";
import type { Layout } from "../src/tui/layout.js";
import { renderInk } from "./helpers/ink.js";

const UP = "\u001b[A";
const DOWN = "\u001b[B";

const turn = (prompt: string, extra: Partial<Turn> = {}): Turn => ({ id: prompt, prompt, blocks: [], ...extra });

describe("promptHistory", () => {
  it("lists the typed prompts newest first, each once where it was used last", () => {
    const turns = [turn("first"), turn("go on"), turn("/compact keep it"), turn("go on"), turn("! git status"), turn("while it worked", { queued: true })];
    expect(promptHistory(turns)).toEqual(["while it worked", "! git status", "go on", "/compact keep it", "first"]);
  });

  it("leaves out the turns nobody typed and prompts of images alone", () => {
    const turns = [
      turn("(session start)", { id: "start" }),
      turn("typed"),
      turn("Agent x reported back", { notification: { kind: "handback", status: "completed", summary: "" } }),
      turn("Conversation compacted", { compacted: true }),
      turn("Session continues in 1234abcd", { continuation: { sessionId: "1234abcd" } }),
      turn("[Image]"),
      turn("[2 images]"),
      turn("   "),
    ];
    expect(promptHistory(turns)).toEqual(["typed"]);
  });

  it("brings back a / command Claude Code did not know, a turn of its own or a warning in the turn it was typed in", () => {
    const warning = (command: string) => ({ kind: "notice" as const, text: `Unknown command: ${command.split(" ")[0]}`, level: "warning" as const, command });
    const turns = [
      turn("fix it", { blocks: [{ kind: "text", text: "Looking." }, warning("/modul sonnet"), { kind: "text", text: "Fixed." }] }),
      turn("/grillng the viewer", { unknownCommand: true, blocks: [warning("/grillng the viewer")] }),
    ];
    expect(promptHistory(turns)).toEqual(["/grillng the viewer", "/modul sonnet", "fix it"]);
  });
});

describe("moveRow", () => {
  it("moves between lines, keeping the column, at most to the line's end", () => {
    expect(moveRow("abc\nde", 6, 20, -1)).toBe(2);
    expect(moveRow("abc\nde", 3, 20, 1)).toBe(6);
    expect(moveRow("abc\nde", 1, 20, 1)).toBe(5);
    expect(moveRow("abc\nde", 1, 20, -1)).toBeUndefined();
    expect(moveRow("abc\nde", 5, 20, 1)).toBeUndefined();
  });

  it("moves between the rows a long line wraps to, staying before the end of a wrapped row", () => {
    // "abcd" | "efgh" | "ij" at four columns.
    expect(moveRow("abcdefghij", 9, 4, -1)).toBe(5);
    expect(moveRow("abcdefghij", 10, 4, -1)).toBe(6);
    expect(moveRow("abcde\nxyzw", 10, 4, -1)).toBe(5);
    expect(moveRow("abcd\nefghij", 4, 4, 1)).toBe(8);
  });

  it("goes by the columns one sees: an emoji takes two", () => {
    expect(moveRow("😀b\nxyz", 6, 20, -1)).toBe(2);
    expect(moveRow("😀b\nxyz", 7, 20, -1)).toBe(3);
    expect(moveRow("😀b\nxyz", 5, 20, -1)).toBe(0);
  });
});

const layout: Layout = { columns: 60, rows: 24, listWidth: 0, previewWidth: 60, bodyHeight: 24 };

function composer(history: string[], extra: { draftKey?: string; sent?: string[]; commands?: { transcript: string; cwd: string; configDir: string } } = {}) {
  const channel: PromptChannel = { send: async (text) => void extra.sent?.push(text), interrupt: async () => {} };
  const element = (props: { draftKey?: string; history: string[] }) => (
    <SessionComposer layout={layout} channel={channel} title="t" working={false} focused onFocus={() => {}} notify={() => {}} onHeight={() => {}} commands={extra.commands} {...props} />
  );
  const view = renderInk(element({ draftKey: extra.draftKey, history }), layout);
  return { view, rerender: (props: { draftKey?: string; history: string[] }) => view.rerender(element(props)) };
}

/** The prompt line's rows, from the one with `›` to the key help. */
const text = (frame: string) => {
  const lines = frame.split("\n");
  const at = lines.findIndex((l) => l.startsWith("›"));
  const end = lines.findIndex((l, i) => i > at && !l.startsWith("  "));
  return lines
    .slice(at, end)
    .map((l) => l.slice(2).trimEnd())
    .join("\n");
};

describe("the prompt line's history", () => {
  it("brings back older prompts with ↑, newer with ↓, and past the newest what was written", async () => {
    const { view } = composer(["newest", "older", "oldest"]);
    // Last in the key help, cut first on a narrow pane.
    await expect.poll(view.frame).toContain("PgUp/Dn scroll  ↑↓ histo…");
    await view.press("draft");
    await expect.poll(() => text(view.frame())).toBe("draft");
    await view.press(UP);
    await expect.poll(() => text(view.frame())).toBe("newest");
    await view.press(UP);
    await expect.poll(() => text(view.frame())).toBe("older");
    await view.press(UP);
    await view.press(UP);
    await expect.poll(() => text(view.frame())).toBe("oldest");
    await view.press(DOWN);
    await expect.poll(() => text(view.frame())).toBe("older");
    await view.press(DOWN);
    await view.press(DOWN);
    await expect.poll(() => text(view.frame())).toBe("draft");
    await view.press(DOWN);
    await view.press("!");
    await expect.poll(() => text(view.frame())).toBe("draft!");
    view.unmount();
  });

  it("moves between the rows of a text first, and browses from its first or last", async () => {
    const { view } = composer(["one\ntwo", "before"]);
    await view.press("ab");
    await view.press("\n");
    await view.press("c");
    await view.press(UP);
    await view.press("X");
    await expect.poll(() => text(view.frame())).toBe("aXb\nc");
    await view.press(UP);
    await expect.poll(() => text(view.frame())).toBe("one\ntwo");
    // Brought back going up, the cursor is on its first row: ↑ goes on at once.
    await view.press(UP);
    await expect.poll(() => text(view.frame())).toBe("before");
    // Brought back going down, it is on the last row: ↓ goes on at once too.
    await view.press(DOWN);
    await expect.poll(() => text(view.frame())).toBe("one\ntwo");
    await view.press(DOWN);
    await expect.poll(() => text(view.frame())).toBe("aXb\nc");
    view.unmount();
  });

  it("goes on from a prompt changed after it was brought back, and sends what is in the line", async () => {
    const sent: string[] = [];
    const { view } = composer(["newest", "older"], { sent });
    await view.press(UP);
    await view.press("\u001b[F");
    await view.press(" too");
    await expect.poll(() => text(view.frame())).toBe("newest too");
    await view.press(UP);
    await expect.poll(() => text(view.frame())).toBe("older");
    await view.press("\r");
    await expect.poll(() => sent).toEqual(["older"]);
    await expect.poll(() => text(view.frame())).toBe("");
    // Sent: browsing starts at the newest again, and ↓ has nothing to go back to.
    await view.press(DOWN);
    await view.press(UP);
    await expect.poll(() => text(view.frame())).toBe("newest");
    view.unmount();
  });

  it("keeps the list of / commands closed for a command brought back, until it is changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-history-"));
    const transcript = join(dir, "session.jsonl");
    const listing = { type: "attachment", isSidechain: false, attachment: { type: "skill_listing", content: "- grilling: does grilling", skillCount: 1, isInitial: true, names: ["grilling"] } };
    writeFileSync(transcript, `${JSON.stringify(listing)}\n`);
    const { view } = composer(["/grilling", "plain"], { commands: { transcript, cwd: join(dir, "project"), configDir: join(dir, "config") } });
    await view.press("/gr");
    await expect.poll(view.frame).toContain("does grilling");
    await view.press("\u0015");
    await expect.poll(view.frame).not.toContain("does grilling");
    await view.press(UP);
    await expect.poll(() => text(view.frame())).toBe("/grilling");
    expect(view.frame()).not.toContain("does grilling");
    await view.press(UP);
    await expect.poll(() => text(view.frame())).toBe("plain");
    await view.press(DOWN);
    await expect.poll(() => text(view.frame())).toBe("/grilling");
    await view.press("\u001b[F");
    await view.press("\u007f");
    await expect.poll(view.frame).toContain("does grilling");
    view.unmount();
  });

  it("starts afresh in another session and keeps the newest in place as prompts come in", async () => {
    const { view, rerender } = composer(["b2", "b1"], { draftKey: "a" });
    await view.press(UP);
    await view.press(UP);
    await expect.poll(() => text(view.frame())).toBe("b1");
    rerender({ draftKey: "a", history: ["new", "b2", "b1"] });
    await view.press(DOWN);
    await expect.poll(() => text(view.frame())).toBe("b2");
    rerender({ draftKey: "b", history: ["other"] });
    await expect.poll(() => text(view.frame())).toBe("");
    await view.press(DOWN);
    await view.press(UP);
    await expect.poll(() => text(view.frame())).toBe("other");
    view.unmount();
  });

  it("names ↑↓ only where there is a history", async () => {
    const { view } = composer([]);
    await expect.poll(view.frame).toContain("Enter send");
    expect(view.frame()).not.toContain("↑↓");
    view.unmount();
  });
});
