import { Text, useInput } from "ink";
import wrapAnsi from "wrap-ansi";
import { Dialog, Spinner, type Layout } from "./layout.js";

/** A step of a run (an update or a repair) as the dialog needs it. */
export interface ProgressStep {
  label: string;
  status: "pending" | "running" | "done" | "failed";
  output: string;
}

export interface Progress {
  title: string;
  /**
   * Running: a spinner and `text`, every key swallowed; waiting: the same after a success (the restart).
   * Done and failed: a mark instead of the spinner, and Esc closes.
   */
  status: "running" | "waiting" | "done" | "failed";
  /** After the spinner. */
  text: string;
  /** A dim line below it, or the lines of a failure. */
  lines?: string[];
  /** Ended: c copies the commands left. */
  copy?: () => void;
}

const MAX_WIDTH = 64;

/** The last `n` lines of a command's output that are not empty, without colours and overwritten progress. */
export function outputTail(text: string, n: number): string[] {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((l) => l.split("\r").at(-1) ?? "")
    .filter((l) => l.trim() !== "")
    .slice(-n);
}

/** "CLI (1/3)": the step running now (or the first that failed, else the last that ran) and where it is among them. */
export function stepText(steps: ProgressStep[]): string | undefined {
  let i = steps.findIndex((s) => s.status === "running" || s.status === "failed");
  if (i < 0) i = steps.filter((s) => s.status !== "pending").length - 1;
  const step = steps[i];
  return step && `${step.label} (${i + 1}/${steps.length})`;
}

/** The end of the failed steps' output, indented; a repair goes on after a failure, so there can be several. */
export function failureLines(steps: ProgressStep[]): string[] {
  const failed = steps.filter((s) => s.status === "failed");
  return failed.flatMap((s) => [...(failed.length > 1 ? [`${s.label}:`] : []), ...outputTail(s.output, 4).map((l) => `  ${l}`)]);
}

/**
 * Shows that a run started from a dialog is under way, so the viewer does not seem to hang:
 * a spinner and what runs now. It cannot be cancelled and takes all keys meanwhile;
 * once it has ended Esc closes it and c copies, if `copy` is given.
 */
export function ProgressDialog({ layout, progress, onClose }: { layout: Layout; progress: Progress; onClose: () => void }) {
  const failed = progress.status === "failed";
  const ended = failed || progress.status === "done";
  useInput((input, key) => {
    if (!ended) return;
    if (key.escape) onClose();
    else if (input === "c") progress.copy?.();
  });

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Inside the border and the padding; output lines keep their indentation when they wrap.
  const inner = Math.max(10, width - 4);
  const lines = (progress.lines ?? []).flatMap((line) => {
    const indent = /^ */.exec(line)![0];
    return wrapAnsi(line.slice(indent.length), inner - indent.length, { hard: true })
      .split("\n")
      .map((l) => indent + l);
  });
  // Title, blank, the spinner's line, the lines, blank, keys, plus the border.
  const height = lines.length + 7;
  const color = failed ? "red" : progress.status === "done" ? "green" : "cyan";
  return (
    <Dialog layout={layout} width={width} height={height} borderColor={color}>
      <Text bold color={color} wrap="truncate">
        {progress.title}
      </Text>
      <Text> </Text>
      <Text wrap="truncate">
        {ended ? <Text color={color}>{failed ? "✗" : "✓"}</Text> : <Spinner active />} {progress.text}
      </Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor={!failed || line.startsWith("  ")} wrap="truncate">
          {line}
        </Text>
      ))}
      <Text> </Text>
      {ended ? (
        <Text wrap="truncate">
          {progress.copy && (
            <>
              <Text color="yellow">c</Text> copy commands{"   "}
            </>
          )}
          <Text color="yellow">Esc</Text> close
        </Text>
      ) : (
        <Text dimColor wrap="truncate">
          Please wait, this cannot be cancelled.
        </Text>
      )}
    </Dialog>
  );
}
