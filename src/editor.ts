import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { render, useApp, useStdout } from "ink";
import { createElement, useEffect, useState } from "react";
import { clearDraft } from "./promptDraft.js";
import { readSettings } from "./settings.js";
import { withoutCtrlC } from "./tui/ctrlC.js";
import { frameBufferedStdout } from "./tui/frameBuffer.js";
import { useMouseReporting } from "./tui/mouse.js";
import type { CommandSource } from "./slashCommands.js";
import { PromptEditor } from "./tui/PromptEditor.js";
import type { Layout } from "./tui/layout.js";

export interface EditorOptions {
  /** The file Claude Code wrote its prompt line into; the prompt is written back there. */
  file: string;
  draftKey: string;
  cwd: string;
  /** Where the session's `/` commands come from. */
  commands?: CommandSource;
}

/** The terminal's size, followed on resize. */
function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const read = () => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);
  return size;
}

function StandaloneEditor({ file, draftKey, cwd, commands, onDone }: EditorOptions & { onDone: (state: "done" | "cancelled") => void }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  useMouseReporting(readSettings().mouse);
  const [initialText] = useState(() => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  });
  const layout: Layout = { columns, rows, listWidth: 0, previewWidth: columns, bodyHeight: rows };
  return createElement(PromptEditor, {
    layout,
    title: `Prompt for Claude Code · ${basename(cwd)}`,
    detail: "Hands it over to Claude Code's prompt line; Enter there sends it.",
    draftKey,
    commands,
    initialText,
    onSubmit: (text: string) => {
      writeFileSync(file, text);
      clearDraft(draftKey);
      onDone("done");
      exit();
    },
    onCancel: () => {
      onDone("cancelled");
      exit();
    },
  });
}

/** Runs the prompt editor in this terminal (Claude Code's pane, which waits for it) until it is handed over or closed. */
export async function runPromptEditor(opts: EditorOptions): Promise<"done" | "cancelled"> {
  let result: "done" | "cancelled" = "cancelled";
  const app = render(createElement(StandaloneEditor, { ...opts, onDone: (state) => (result = state) }), {
    stdout: process.stdout.isTTY && process.env.CCO_FRAME_BUFFER !== "0" ? frameBufferedStdout(process.stdout) : process.stdout,
    stdin: process.stdin.isTTY ? withoutCtrlC(process.stdin) : process.stdin,
    alternateScreen: true,
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
  return result;
}
