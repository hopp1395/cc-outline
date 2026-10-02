/**
 * Delays of the viewer's timers that tests wait for. One mutable object, read when a timer starts,
 * so `test/setup.ts` can shorten them; the code never changes them.
 */
export const TIMING = {
  /** How long `Restarting…` shows before the viewer moves (restart, after an update). */
  restartDelay: 1000,
  /** The pause before each group of the doctor's check in Settings. */
  checkStep: 300,
  /** How often Sessions reads which sessions run and what Claude does there. */
  activityPoll: 1000,
  /** How often Sessions looks for the Claude Code it started to attach to. */
  pairPoll: 500,
  /** One phase of the blinking marker of a working session. */
  blink: 500,
  /** How long the top bar says `reloaded`. */
  reloaded: 1500,
  /** How often a `FileTail` stats its file, besides the watcher. */
  tailStat: 1000,
};
