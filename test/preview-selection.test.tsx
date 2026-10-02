import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import { AreaContext } from "../src/tui/layout.js";
import { MouseContext } from "../src/tui/mouse.js";
import { Preview } from "../src/tui/Preview.js";
import { clipboard } from "../src/tui/useClipboard.js";

const copied: string[] = [];
const real = { ...clipboard };
beforeAll(() => {
  clipboard.copy = async (text: string) => {
    copied.push(text);
  };
});
afterAll(() => {
  Object.assign(clipboard, real);
});

const wait = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  copied.length = 0;
});

/** A preview at column 20, row 2 of the terminal, as if a list were left of it, and a way to send it mouse reports. */
async function mount(header: string[], lines: string[]) {
  const app = renderInk(
    <MouseContext.Provider value={true}>
      <AreaContext.Provider value={{ x: 20, y: 2, width: 30, height: 6 }}>
        <Preview header={header} lines={lines} scroll={0} width={30} height={6} />
      </AreaContext.Provider>
    </MouseContext.Provider>,
    { columns: 60, rows: 10 },
  );
  await wait();
  const send = async (...inputs: string[]) => {
    for (const input of inputs) {
      await app.press(input);
      await wait();
    }
  };
  const out = {
    get frame() {
      return app.frame();
    },
    get raw() {
      return app.raw();
    },
  };
  return { out, send, app };
}

it("selects text in the preview with a drag, highlights it and copies it", async () => {
  const { out, send, app } = await mount(["Header", "──"], ["first line", "second line here", "", "fourth line"]);
  // SGR reports are one-based: press on "line" of the first line (row 4 = body row 0), drag to "fourth".
  await send("\u001b[<0;27;5M", "\u001b[<32;25;7M", "\u001b[<32;26;8M", "\u001b[<0;26;8m");
  expect(copied).toEqual(["line\nsecond line here\n\nfourth"]);
  expect(out.raw).toContain("\u001b[7mline\u001b[27m");
  expect(out.frame).toContain("copied 4 lines");
  // A click elsewhere drops the selection.
  await send("\u001b[<0;22;5M\u001b[<0;22;5m");
  expect(out.raw).not.toContain("\u001b[7m");
  // So does the right button, wherever it is pressed.
  await send("\u001b[<0;27;5M", "\u001b[<32;29;5M", "\u001b[<0;29;5m");
  expect(out.raw).toContain("\u001b[7mlin\u001b[27m");
  await send("\u001b[<2;5;1M");
  expect(out.raw).not.toContain("\u001b[7m");
  expect(copied).toEqual(["line\nsecond line here\n\nfourth", "lin"]);
  app.unmount();
});

it("selects the prompt in the header without its marker, indentation and rule", async () => {
  const { out, send, app } = await mount(["❯ fix the wrapped", "  prompt text", "─".repeat(30)], ["answer"]);
  // From "fix" (row 3, column 23) down past the rule into the body: the selection stays in the header.
  await send("\u001b[<0;23;3M", "\u001b[<32;25;4M", "\u001b[<32;40;7M", "\u001b[<0;40;7m");
  expect(copied).toEqual(["fix the wrapped\nprompt text"]);
  expect(out.raw).toContain("\u001b[7mfix the wrapped\u001b[27m");
  app.unmount();
});
