import { useEffect, useState } from "react";
import { installedVersion, linkedHere, remainingCommands, runUpdate, shimRoot, UPDATE_STEPS, type StepResult } from "../update.js";
import { shimCli } from "../cliPath.js";
import { tilde } from "./sessionHead.js";
import { TIMING } from "../timing.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import type { Layout } from "./layout.js";
import { currentStep, failureLines, REOPEN_BY_HAND, stepText, useProgress, type Progress, type ProgressStep } from "./ProgressDialog.js";

/** The switch from a linked checkout to the release: its steps as they go, then whether it worked. */
export interface SwitchRun {
  status: "running" | "done" | "failed";
  steps: StepResult[];
  /** Done, but the viewer could not reopen itself: it has to be closed and opened by hand. */
  reopenFailed?: boolean;
}

const TITLE = "Switch to the release";

/** The switch's progress dialog: the step running, then the restart, or where it stopped. `reopen` says what to do when the viewer cannot reopen itself. */
export function switchProgress(run: SwitchRun, reopen: string, onClose: () => void): Progress {
  const steps: ProgressStep[] = run.steps.map((s) => ({ label: s.step.label, status: s.status, output: s.output }));
  if (run.status === "running") return { title: TITLE, status: "running", text: "Installing", step: currentStep(steps) };
  if (run.status === "failed")
    return {
      title: TITLE,
      status: "failed",
      text: `The switch stopped at ${stepText(currentStep(steps))}`,
      lines: [...failureLines(steps), "Run the rest by hand, then reopen the viewer:", ...remainingCommands(run.steps).map((c) => `  ${c}`)],
      onClose,
    };
  if (run.reopenFailed) return { title: TITLE, status: "done", text: "Switched to the release", lines: [reopen, "Restart Claude Code for the plugin."], onClose };
  return { title: TITLE, status: "waiting", text: "Restarting", detail: "Switched to the release" };
}

/** What a click on DEV shows for a checkout run directly (`node dist/cli.js`): the `cco` command runs another install. */
export function notLinkedProgress(root: string, onClose: () => void): Progress {
  return {
    title: "Development version",
    status: "done",
    text: "Runs from a checkout",
    lines: [`This viewer runs ${tilde(root)} directly, not through npm link: the cco command starts another install, so there is nothing to switch.`],
    onClose,
  };
}

/**
 * A click on DEV: for a checkout linked as the `cco` command (`npm link`), asks, then installs the release in
 * its place (the update's steps) and reopens the viewer with it through `onRestart`; for one run directly, says
 * there is nothing to switch. The checkout itself stays as it is. `onClose` once it is done or declined.
 */
export function DevSwitchDialog({
  layout,
  root,
  onRestart,
  onClose,
}: {
  layout: Layout;
  root: string;
  /** Reopens the viewer with `version` run by `cli`; false if it could not. Undefined where cco open cannot reopen it (a viewer of one session, the Remote Control Viewer). */
  onRestart?: (version: string, cli: string) => boolean;
  onClose: () => void;
}) {
  const [linked] = useState(() => linkedHere(root));
  const [asked, setAsked] = useState(linked);
  const [run, setRun] = useState<SwitchRun>();
  useEffect(() => {
    if (linked && !asked && !run) onClose();
  }, [asked, run]);

  const reopenFailed = () => setRun((r) => r && { ...r, reopenFailed: true });
  const start = () => {
    setRun({ status: "running", steps: [] });
    void runUpdate((steps) => setRun((r) => r && { ...r, steps })).then((ok) => {
      setRun((r) => r && { ...r, status: ok ? "done" : "failed" });
      if (!ok) return;
      setTimeout(() => {
        const cli = shimCli();
        const global = shimRoot(cli);
        const version = global && installedVersion(global);
        if (!(cli && version && onRestart?.(version, cli))) reopenFailed();
      }, TIMING.restartDelay);
    });
  };

  const reopen = onRestart ? REOPEN_BY_HAND : "Close the viewer with q and open it again.";
  useProgress(!linked ? notLinkedProgress(root, onClose) : run ? switchProgress(run, reopen, onClose) : undefined);

  if (!asked) return null;
  return (
    <ConfirmDialog
      layout={layout}
      confirmation={{
        title: "Switch to the release of cco?",
        lines: [`cco runs the checkout ${tilde(root)} (npm link).`, "Installs the release in its place:", ...UPDATE_STEPS.map((s) => `  ${s.command}`), "The checkout stays; npm link there switches back."],
        onConfirm: start,
      }}
      onClose={() => setAsked(false)}
    />
  );
}
