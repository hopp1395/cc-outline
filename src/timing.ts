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
  /** How long the keeper's mark of a session that just finished blinks at most, unseen. */
  freshIdle: 10 * 60_000,
  /** How long it blinks when the session was selected in the focused keeper as it finished. */
  freshSelected: 3000,
  /** How long the top bar says `reloaded`. */
  reloaded: 1500,
  /** How often a `FileTail` stats its file, besides the watcher. */
  tailStat: 1000,
  /** How often a remote viewer asks claude.ai for the session's new events. */
  remotePoll: 1000,
  /** How often the chat reads the folders of a running workflow for its agents. */
  workflowPoll: 1000,
};
