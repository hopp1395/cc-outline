import { useStdout } from "ink";
import { useCallback } from "react";
import { copyToClipboard } from "../clipboard.js";

/** Copies text to the clipboard, through Ink's stdout where it is an OSC 52 sequence. */
export function useClipboard(): (text: string) => Promise<void> {
  const { stdout } = useStdout();
  return useCallback((text: string) => copyToClipboard(text, stdout), [stdout]);
}
