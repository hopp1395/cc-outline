import { useStdout } from "ink";
import { useCallback } from "react";
import { copyToClipboard } from "../clipboard.js";

/** What `useClipboard` copies with, read at each copy, so tests can see the text instead of the clipboard getting it. */
export const clipboard = { copy: copyToClipboard };

/** Copies text to the clipboard, through Ink's stdout where it is an OSC 52 sequence. */
export function useClipboard(): (text: string) => Promise<void> {
  const { stdout } = useStdout();
  return useCallback((text: string) => clipboard.copy(text, stdout), [stdout]);
}
