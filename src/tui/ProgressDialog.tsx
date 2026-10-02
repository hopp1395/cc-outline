import { Text, useInput } from "ink";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import wrapAnsi from "wrap-ansi";
import { Dialog, Spinner, type Layout } from "./layout.js";

/** A step of a run (an update or a repair) as the dialog needs it. */
export interface ProgressStep {
  label: string;
  status: "pending" | "running" | "done" | "failed";
  output: string;
}

/**
 * A run the user started (update, doctor, repair, export, import, attaching, restart), shown by the one
 * progress dialog of the app. The title names the run and stays the same; the state shows in the mark
 * before `text` (spinner, ✓, ✗) and in the frame's colour.
 */
export interface Progress {
  title: string;
  /**
   * Running: a spinner and `Verb – step (n/m)…`, every key swallowed but Esc with `onCancel`; waiting:
   * the same after a success (the restart). Done and failed: a mark instead of the spinner, and Esc closes.
   */
  status: "running" | "waiting" | "done" | "failed";
  /** Running: the verb ("Updating"); ended: the outcome ("Exported 2 sessions"). */
  text: string;
  /** Running: the step under way, and where it is among them. */
  step?: { label: string; at?: number; of?: number };
  /** A dim line below the text: what the run works on (a session, a file, the time waited). */
  detail?: string;
  /** Ended: the result, or the lines of a failure (indented ones are output). */
  lines?: string[];
  /** Ended: c copies the commands left. */
  copy?: () => void;
  /** Running: Esc cancels it. Only runs that can stop halfway without harm take it. */
  onCancel?: () => void;
  /** Ended: Esc closes the dialog. */
  onClose?: () => void;
}

const MAX_WIDTH = 64;

/** What a restart (on its own or after an update) says when `cco open` cannot reopen the viewer. */
export const REOPEN_BY_HAND = "The viewer cannot reopen itself here: close it with q and open it again.";

/** The last `n` lines of a command's output that are not empty, without colours and overwritten progress. */
export function outputTail(text: string, n: number): string[] {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((l) => l.split("\r").at(-1) ?? "")
    .filter((l) => l.trim() !== "")
    .slice(-n);
}

/** The step running now (or the first that failed, else the last that ran) and where it is among them. */
export function currentStep(steps: ProgressStep[]): Progress["step"] {
  let i = steps.findIndex((s) => s.status === "running" || s.status === "failed");
  if (i < 0) i = steps.filter((s) => s.status !== "pending").length - 1;
  const step = steps[i];
  return step && { label: step.label, at: i + 1, of: steps.length };
}

/** "CLI (1/3)": a step with where it is among them. */
export function stepText(step: Progress["step"]): string | undefined {
  return step && (step.at !== undefined && step.of !== undefined ? `${step.label} (${step.at}/${step.of})` : step.label);
}

/** The line after the spinner or mark: `Updating – CLI (1/3)…` while it runs, the outcome once it has ended. */
export function progressText(progress: Progress): string {
  if (progress.status === "done" || progress.status === "failed") return progress.text;
  const step = stepText(progress.step);
  return `${progress.text}${step ? ` – ${step}` : ""}…`;
}

/** The end of the failed steps' output, indented; a repair goes on after a failure, so there can be several. */
export function failureLines(steps: ProgressStep[]): string[] {
  const failed = steps.filter((s) => s.status === "failed");
  return failed.flatMap((s) => [...(failed.length > 1 ? [`${s.label}:`] : []), ...outputTail(s.output, 4).map((l) => `  ${l}`)]);
}

/**
 * Shows that a run is under way, so the viewer does not seem to hang: a spinner and what runs now.
 * It takes all keys meanwhile; Esc cancels a run that can be cancelled. Once it has ended, Esc closes
 * it and c copies, if `copy` is given.
 */
export function ProgressDialog({ layout, progress }: { layout: Layout; progress: Progress }) {
  const failed = progress.status === "failed";
  const ended = failed || progress.status === "done";
  useInput((input, key) => {
    if (!ended) {
      if (key.escape) progress.onCancel?.();
      return;
    }
    if (key.escape) progress.onClose?.();
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
  const detail = progress.detail !== undefined;
  // Title, blank, the spinner's line, the detail, the lines, blank, keys, plus the border.
  const height = lines.length + (detail ? 1 : 0) + 7;
  const color = failed ? "red" : progress.status === "done" ? "green" : "cyan";
  return (
    <Dialog layout={layout} width={width} height={height} borderColor={color}>
      <Text bold color={color} wrap="truncate">
        {progress.title}
      </Text>
      <Text> </Text>
      <Text wrap="truncate">
        {ended ? <Text color={color}>{failed ? "✗" : "✓"}</Text> : <Spinner active />} {progressText(progress)}
      </Text>
      {detail && (
        <Text dimColor wrap="truncate">
          {"  "}
          {progress.detail}
        </Text>
      )}
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
      ) : progress.onCancel ? (
        <Text wrap="truncate">
          <Text color="yellow">Esc</Text> cancel
        </Text>
      ) : (
        <Text dimColor wrap="truncate">
          Please wait, this cannot be cancelled.
        </Text>
      )}
    </Dialog>
  );
}

/** The app's one progress dialog: each run sets its progress under an owner, the one set last shows. */
export interface ProgressHost {
  set: (owner: string, progress: Progress | undefined) => void;
  /** A run's dialog is open: views and the app take no keys. */
  open: boolean;
}

const ProgressContext = createContext<ProgressHost | undefined>(undefined);

/** The host's state, for the app (which shows the restart itself) and for tests through `ProgressProvider`. */
export function useProgressHost(layout: Layout): { host: ProgressHost; dialog: ReactNode } {
  const [shown, setShown] = useState<{ owner: string; progress: Progress }[]>([]);
  const set = useCallback(
    (owner: string, progress: Progress | undefined) =>
      setShown((list) => {
        const rest = list.filter((e) => e.owner !== owner);
        if (!progress) return rest.length === list.length ? list : rest;
        return [...rest, { owner, progress }];
      }),
    [],
  );
  const current = shown.at(-1)?.progress;
  const open = current !== undefined;
  const host = useMemo(() => ({ set, open }), [set, open]);
  return { host, dialog: current && <ProgressDialog layout={layout} progress={current} /> };
}

/** Provides a progress host and shows its dialog below `children`. */
export function ProgressProvider({ layout, children }: { layout: Layout; children: ReactNode }) {
  const { host, dialog } = useProgressHost(layout);
  return (
    <ProgressContext.Provider value={host}>
      {children}
      {dialog}
    </ProgressContext.Provider>
  );
}

export function ProgressHostProvider({ host, children }: { host: ProgressHost; children: ReactNode }) {
  return <ProgressContext.Provider value={host}>{children}</ProgressContext.Provider>;
}

/** Whether a run's dialog is open; a view takes no keys then. */
export function useProgressOpen(): boolean {
  return useContext(ProgressContext)?.open ?? false;
}

/**
 * Shows `progress` in the app's progress dialog while it is defined. Its callbacks may change on every
 * render: the dialog calls the latest ones, and it is updated only when what it shows changes.
 */
export function useProgress(progress: Progress | undefined): void {
  const set = useContext(ProgressContext)?.set;
  const owner = useId();
  const latest = useRef(progress);
  latest.current = progress;
  // Callbacks count by their presence, so a new closure does not set the dialog again.
  const shown = progress && JSON.stringify(progress, (_, v: unknown) => (typeof v === "function" ? true : v));
  useEffect(() => {
    if (!set) return;
    const p = latest.current;
    const call = (name: "copy" | "onCancel" | "onClose") => p?.[name] && (() => latest.current?.[name]?.());
    set(owner, p && { ...p, copy: call("copy"), onCancel: call("onCancel"), onClose: call("onClose") });
  }, [shown, set]);
  useEffect(() => () => set?.(owner, undefined), [set]);
}
