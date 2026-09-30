import { PassThrough } from "node:stream";
import { Box, render } from "ink";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import type { Layout } from "../src/tui/layout.js";
import { WhatsNewDialog } from "../src/tui/WhatsNewDialog.js";
import { VERSION } from "../src/version.js";

const layout: Layout = { columns: 100, rows: 20, listWidth: 30, previewWidth: 67, bodyHeight: 16 };

function renderDialog(onClose: () => void) {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: layout.columns, rows: layout.rows });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, setEncoding: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  stdout.on("data", (chunk) => {
    const text = stripAnsi(String(chunk));
    if (text.trim()) frame = text;
  });
  const releases = [
    { tag: "v0.10.0", version: "0.10.0", title: "v0.10.0", body: "- Newest thing", date: "2026-09-30T10:00:00Z" },
    { tag: "v0.9.1", version: "0.9.1", title: "v0.9.1", body: Array.from({ length: 30 }, (_, i) => `- Fix ${i + 1}`).join("\n") },
  ];
  // The dialog is placed absolutely, over a screen of the layout's size.
  const screen = (
    <Box width={layout.columns} height={layout.rows}>
      <WhatsNewDialog layout={layout} releases={releases} from="0.9.0" onClose={onClose} />
    </Box>
  );
  const app = render(screen, {
    stdout: stdout as never,
    stdin: stdin as never,
    debug: true,
    patchConsole: false,
  });
  return { frame: () => frame, press: (keys: string) => stdin.write(keys), unmount: () => app.unmount() };
}

describe("WhatsNewDialog", () => {
  it("shows the notes of every release since the one run before, scrolls and closes with Enter", async () => {
    let closed = 0;
    const view = renderDialog(() => closed++);
    await expect.poll(view.frame, { timeout: 2000 }).toContain(`cco updated to v${VERSION} from v0.9.0 · 2 releases`);
    expect(view.frame()).toContain("v0.10.0 · 2026-09-30");
    expect(view.frame()).toContain("Newest thing");
    expect(view.frame()).not.toContain("Fix 30");
    // End scrolls to the last line: the skipped release's notes are there too.
    view.press("\u001b[F");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("Fix 30");
    view.press("\r");
    await expect.poll(() => closed, { timeout: 2000 }).toBe(1);
    view.unmount();
  });
});
