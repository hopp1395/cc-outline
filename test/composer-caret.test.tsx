import chalk from "chalk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TIMING } from "../src/timing.js";
import { FocusContext } from "../src/tui/focus.js";
import { QuestionDialog, type Question } from "../src/tui/QuestionDialog.js";
import { SessionComposer, type PromptChannel } from "../src/tui/SessionComposer.js";
import type { Layout } from "../src/tui/layout.js";
import { renderInk, tick, until } from "./helpers/ink.js";
import stripAnsi from "strip-ansi";

const layout: Layout = { columns: 80, rows: 24, listWidth: 0, previewWidth: 80, bodyHeight: 24 };
const INVERSE = "\u001b[7m";
const channel: PromptChannel = { send: async () => {}, interrupt: async () => {} };

/** The prompt line alone: the cursor is the only thing drawn inverse. */
const composer = (focused: boolean, windowFocused = true) =>
  renderInk(
    <FocusContext.Provider value={windowFocused}>
      <SessionComposer layout={layout} channel={channel} title="t" working={false} focused={focused} onFocus={() => {}} notify={() => {}} onHeight={() => {}} />
    </FocusContext.Provider>,
    layout,
  );

const questions: Question[] = [{ question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Blue" }, { label: "Red" }] }];
const question = (active: boolean, windowFocused = true) =>
  renderInk(
    <FocusContext.Provider value={windowFocused}>
      <QuestionDialog inline active={active} layout={layout} title="Claude asks" questions={questions} onSend={() => {}} onCancel={() => {}} onLeave={() => {}} idle={["Space", "or a click: answer it"]} />
    </FocusContext.Provider>,
    layout,
  );
const pointed = (frame: string) => stripAnsi(frame).includes("› ( ) 1. Blue");

describe("the mark of where the keys go", () => {
  // Ink draws the cursor's inverse through chalk, which writes no codes to the fake terminal on its own.
  const level = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = level;
  });

  it("blinks the prompt line's cursor while the line has the keys", async () => {
    const view = composer(true);
    await until(() => view.frame().includes("Enter send"));
    const from = view.count();
    await tick(5 * TIMING.blink);
    const frames = view.frames.slice(from);
    expect(frames.some((f) => f.includes(INVERSE))).toBe(true);
    expect(frames.some((f) => !f.includes(INVERSE))).toBe(true);
    view.unmount();
  });

  it("keeps the cursor on while one types", async () => {
    const view = composer(true);
    await until(() => view.frame().includes("Enter send"));
    await view.press("a");
    const from = view.count();
    for (let i = 0; i < 12; i++) {
      await view.press("a");
      await tick(TIMING.blink / 4);
    }
    expect(view.frames.slice(from).every((f) => f.includes(INVERSE))).toBe(true);
    view.unmount();
  });

  it("holds the cursor steady while the window has not the focus, and shows none without the keys", async () => {
    const steady = composer(true, false);
    await until(() => steady.frame().includes("Enter send"));
    const from = steady.count();
    await tick(5 * TIMING.blink);
    expect(steady.frames.slice(from).every((f) => f.includes(INVERSE))).toBe(true);
    expect(steady.raw()).toContain(INVERSE);
    steady.unmount();

    const without = composer(false);
    await until(() => without.frame().includes("write a prompt"));
    await tick(3 * TIMING.blink);
    expect(without.frames.some((f) => f.includes(INVERSE))).toBe(false);
    without.unmount();
  });

  it("blinks a question's › while it has the keys, steady without the window's focus, gone without the keys", async () => {
    const view = question(true);
    await until(() => view.frame().includes("Which colour?"));
    const from = view.count();
    await tick(5 * TIMING.blink);
    const frames = view.frames.slice(from);
    expect(frames.some(pointed)).toBe(true);
    expect(frames.some((f) => !pointed(f))).toBe(true);
    view.unmount();

    const steady = question(true, false);
    await until(() => steady.frame().includes("Which colour?"));
    await tick(3 * TIMING.blink);
    expect(steady.frames.every(pointed)).toBe(true);
    steady.unmount();

    const without = question(false);
    await until(() => without.frame().includes("Which colour?"));
    await tick(3 * TIMING.blink);
    expect(without.frames.some(pointed)).toBe(false);
    without.unmount();
  });

  it("names the key that gives a question the keys in place of its own while it has not them", async () => {
    const view = question(false);
    await until(() => view.frame().includes("Space or a click: answer it"));
    expect(view.frame()).not.toContain("↑↓ row");
    expect(view.frame()).not.toContain("Tab chat");
    view.unmount();

    const answering = question(true);
    await until(() => answering.frame().includes("↑↓ row"));
    expect(answering.frame()).not.toContain("or a click");
    answering.unmount();
  });
});
