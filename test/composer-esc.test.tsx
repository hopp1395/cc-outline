import { useInput } from "ink";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { PromptImage } from "../src/promptDraft.js";
import { TIMING } from "../src/timing.js";
import { SessionComposer, type HandedPrompt, type PromptChannel } from "../src/tui/SessionComposer.js";
import type { Layout } from "../src/tui/layout.js";
import { renderInk, tick, until } from "./helpers/ink.js";

const layout: Layout = { columns: 110, rows: 24, listWidth: 0, previewWidth: 110, bodyHeight: 24 };
const ESC = "\u001b";
const UP = "\u001b[A";
const DOWN = "\u001b[B";

/** The prompt line below a stand-in chat, which gives it the keys back with `i`. */
function Harness(props: { channel: PromptChannel; working?: boolean; history?: string[]; notices: string[]; draftKey?: string; handed?: HandedPrompt }) {
  const [focused, setFocused] = useState(true);
  useInput((input) => input === "i" && setFocused(true), { isActive: !focused });
  return (
    <SessionComposer
      layout={layout}
      channel={props.channel}
      title="t"
      working={props.working ?? false}
      focused={focused}
      onFocus={setFocused}
      notify={(text) => props.notices.push(text)}
      onHeight={() => {}}
      history={props.history}
      draftKey={props.draftKey}
      handed={props.handed}
    />
  );
}

const setup = (extra: { working?: boolean; history?: string[]; draftKey?: string; handed?: HandedPrompt } = {}) => {
  const sent: { text: string; images?: PromptImage[] }[] = [];
  let interrupts = 0;
  const notices: string[] = [];
  const channel: PromptChannel = {
    send: async (text, images) => void sent.push({ text, images }),
    interrupt: async () => void interrupts++,
  };
  const view = renderInk(<Harness channel={channel} notices={notices} {...extra} />, layout);
  return { view, sent, notices, interrupts: () => interrupts };
};

describe("Esc in the prompt line", () => {
  it("keeps the keys with text: Esc asks for a second, Esc Esc clears, ↑ brings it back before the prompts sent", async () => {
    const { view, notices } = setup({ history: ["sent before"] });
    await view.press("half a thought");
    await until(() => view.frame().includes("Esc Esc clear") && view.frame().includes("Tab chat"));
    await view.press(ESC);
    await until(() => view.frame().includes("Esc again to clear"));
    expect(view.frame()).toContain("› half a thought");
    expect(view.frame()).not.toContain("Tab write a prompt");
    await view.press(ESC);
    await until(() => !view.frame().includes("half a thought"));
    expect(notices).toContain("draft cleared · ↑ brings it back");
    // The line keeps the keys; empty, its Esc hands them to the chat.
    expect(view.frame()).toContain("Enter send");
    expect(view.frame()).toContain("Esc chat");
    await view.press(UP);
    await until(() => view.frame().includes("› half a thought"));
    await view.press(UP);
    await until(() => view.frame().includes("› sent before"));
    await view.press(DOWN);
    await until(() => view.frame().includes("› half a thought"));
    view.unmount();
  });

  it("hands the keys to the chat with Esc on an empty line, and with Tab", async () => {
    const { view } = setup();
    await view.press(ESC);
    await until(() => view.frame().includes("Tab write a prompt"));
    await view.press("i");
    await view.press("some text");
    await view.press("\t");
    await until(() => view.frame().includes("Tab write a prompt") && view.frame().includes("› some text"));
    view.unmount();
  });

  it("clears as well when both Esc come in one read", async () => {
    const { view } = setup();
    await view.press("typed fast");
    await view.press(ESC + ESC);
    await until(() => !view.frame().includes("typed fast"));
    expect(view.frame()).toContain("Enter send");
    view.unmount();
  });

  it("keeps the draft when the second Esc comes late or after another key", async () => {
    const { view } = setup();
    await view.press("keep me");
    await view.press(ESC);
    await until(() => view.frame().includes("Esc again to clear"));
    await until(() => view.frame().includes("Esc Esc clear"));
    await view.press(ESC);
    await tick();
    expect(view.frame()).toContain("› keep me");
    await view.press("x");
    await view.press(ESC);
    await tick();
    expect(view.frame()).toContain("› keep mex");
    view.unmount();
  });

  it("stops Claude once: an Esc right after the stop keeps the keys and the draft", async () => {
    const run = setup({ working: true });
    const { view } = run;
    await view.press("go on with the tests");
    await until(() => view.frame().includes("Esc stop Claude"));
    expect(view.frame()).not.toContain("Esc Esc clear");
    await view.press(ESC);
    await expect.poll(() => run.interrupts()).toBe(1);
    // Claude still shows as working: the next Esc, also two in one read, neither stops it again nor clears.
    await view.press(ESC);
    await view.press(ESC + ESC);
    await tick();
    expect(run.interrupts()).toBe(1);
    expect(view.frame()).toContain("Enter send");
    expect(view.frame()).toContain("› go on with the tests");
    // Later, Esc stops it again.
    await tick(TIMING.escTwice + 50);
    await view.press(ESC);
    await expect.poll(() => run.interrupts()).toBe(2);
    view.unmount();
  });

  it("brings a cleared draft back with the prompt editor's images, which go along again", async () => {
    const image: PromptImage = { n: 1, path: "/tmp/a.png", source: "png", bytes: 10, at: 1 };
    const run = setup({ draftKey: "s", handed: { key: "s", text: "look at [Image #1]", images: [image], at: 1 } });
    const { view } = run;
    await until(() => view.frame().includes("⎘ [Image #1] go along"));
    await view.press(ESC);
    await until(() => view.frame().includes("Esc again to clear"));
    await view.press(ESC);
    await until(() => !view.frame().includes("look at"));
    expect(view.frame()).not.toContain("go along");
    await view.press(UP);
    await until(() => view.frame().includes("⎘ [Image #1] go along"));
    await view.press("\r");
    await expect.poll(() => run.sent).toEqual([{ text: "look at [Image #1]", images: [image] }]);
    view.unmount();
  });
});
