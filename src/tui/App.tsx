import { Box, useApp, useInput, useStdout } from "ink";
import { basename } from "node:path";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { repoRoot } from "../git/git.js";
import { detectTerminal, moveViewer } from "../open.js";
import { suspendPositionWrites } from "../positions.js";
import { clearProjectData } from "../projectData.js";
import { readSessionView, resolvePlacement, saveSessionPlacement, saveSessionView } from "../sessionViews.js";
import { isViewShown, nextShownView, readSettings, shownView, type Placement } from "../settings.js";
import { continueSession } from "../transcript/locate.js";
import type { Turn } from "../transcript/parse.js";
import { detachViewer, pairViewer, setViewerView, writeTargetSession, type PairTarget, type ViewerAction } from "../viewer.js";
import { ChatView } from "./ChatView.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { FocusContext, useTerminalFocus } from "./focus.js";
import { GitView } from "./GitView.js";
import { InfoDialog } from "./InfoDialog.js";
import { MonitorView } from "./MonitorView.js";
import { MouseContext, parseMouse, useMouseReporting } from "./mouse.js";
import { PlacementDialog } from "./PlacementDialog.js";
import { ProgressHostProvider, REOPEN_BY_HAND, useProgressHost } from "./ProgressDialog.js";
import { WhatsNewDialog } from "./WhatsNewDialog.js";
import { SessionColorContext, tabAt, useLayout, type Mode } from "./layout.js";
import { PlanView } from "./PlanView.js";
import { isEmptySession } from "./resumeChoice.js";
import { ReloadContext, useReloadKey } from "./reload.js";
import { SessionsView } from "./SessionsView.js";
import { SettingsView } from "./SettingsView.js";
import { useTerminalTitle } from "./title.js";
import { UpdateContext, useUpdate } from "./useUpdate.js";
import { useSetting } from "./useSetting.js";
import { useSessionPath, useTranscript } from "./useTranscript.js";
import { useViewerControl } from "./useViewerControl.js";
import { TIMING } from "../timing.js";

interface Props {
  cwd: string;
  sessionId?: string;
  /** The view to start with; without it, the session's last view (setting rememberView), else the chat. */
  initialMode?: Mode;
  /** The pane was opened without taking the focus (focus stayed in Claude Code). */
  unfocused?: boolean;
  /** The Claude Code process the viewer belongs to; its session is shown. */
  claudePid?: number;
  /** Where the viewer was opened (passed on by `cco open`); p moves it elsewhere. */
  placement?: Placement;
  /** An entry to select in the start view (`releases` in Settings, from /cco:releases). */
  select?: string;
  /** The viewer reopened after an update to this version. */
  updatedTo?: string;
  /** Started by /cco:update: check for an update at once and offer it. */
  action?: ViewerAction;
  /** Pairs the viewer with a running Claude Code process (Sessions); the viewer then shows its session. */
  onPair?: (cwd: string, claudePid: number) => void;
  /** Detaches the viewer from its Claude Code (Sessions); it then follows the project's newest session. */
  onDetach?: (cwd: string) => void;
}

const VIEW_KEYS: Record<string, Mode> = { "1": "chat", "2": "git", "3": "plan", "4": "sessions", "5": "monitor", "6": "settings" };

/**
 * When the last prompt was typed in Claude Code, if that was after `since`: the
 * focus is there then. Notifications are not typed; turns loaded at the start are older.
 */
function typedInClaude(turns: Turn[], since: number): number | undefined {
  const last = [...turns].reverse().find((t) => !t.notification && !t.continuation && !t.compacted);
  const at = last?.timestamp ? Date.parse(last.timestamp) : NaN;
  return at > since ? at : undefined;
}

const sessionOf = (path?: string) => (path ? basename(path, ".jsonl") : undefined);

/** A control-only write: the frame buffer draws the next frame in full, clearing the screen. */
const REDRAW = "\u001b[?25l";
const NO_RELOADS: Record<Mode, number> = { chat: 0, git: 0, plan: 0, sessions: 0, settings: 0, monitor: 0 };

export function App({ cwd, sessionId, initialMode, unfocused = false, claudePid, placement, select: initialSelect, updatedTo, action: initialAction, onPair, onDetach }: Props) {
  const { exit } = useApp();
  const [startedAt] = useState(Date.now);
  const layout = useLayout();
  const { stdout } = useStdout();
  // F5 reloads the shown view: how often each was reloaded, and the one reloading now.
  const [reloads, setReloads] = useState(NO_RELOADS);
  const [reloading, setReloading] = useState<{ mode: Mode; done: boolean }>();
  // The chat and the plan view share the transcript: a reload of either reads it afresh.
  const transcriptReload = reloads.chat + reloads.plan;
  const opened = useSessionPath(cwd, sessionId, claudePid, transcriptReload);
  // Parsed once for the chat and the plan view.
  const transcript = useTranscript(opened, transcriptReload);
  // The transcript read now: the session may have continued in another one.
  const path = transcript.file ?? opened;
  const focused = useTerminalFocus(!unfocused, typedInClaude(transcript.turns, startedAt));
  // The taskbar and the tab show the session, like Claude Code's own, instead of "cco".
  // Like Claude Code's title: ◐/◑ while the last turn runs, ✳ when it waits; a viewer of a --session shows no status.
  const lastTurn = transcript.turns.at(-1);
  const working = lastTurn !== undefined && !lastTurn.done && !lastTurn.interrupted;
  useTerminalTitle(transcript.title ?? basename(cwd), sessionId ? undefined : working ? "working" : "idle");
  const [rememberView] = useSetting("rememberView");
  // An explicit --view opens its view even when hidden; a remembered or default one only if shown.
  const [mode, setMode] = useState<Mode>(() => {
    const settings = readSettings();
    return initialMode ?? shownView(settings, (settings.rememberView ? readSessionView(cwd, sessionOf(path)) : undefined) ?? "chat");
  });
  const [infoOpen, setInfoOpen] = useState(false);
  // Bumped by the project data reset: the views mount afresh and read the now empty files.
  const [generation, setGeneration] = useState(0);
  // p: where the viewer runs (right, left, own window).
  const [placementOpen, setPlacementOpen] = useState(false);
  // A view's confirmation dialog takes all keys while it is open.
  const [modal, setModal] = useState(false);
  // A view's filter dialog takes the typed keys; the mouse still reaches the list.
  const [typing, setTyping] = useState(false);
  // q or Esc asks before quitting; the viewer still closes by itself when the session ends.
  const [quitAsked, setQuitAsked] = useState(false);
  const [confirmQuit] = useSetting("confirmQuit");
  // The one progress dialog of all runs the user starts (update, doctor, export, import, attaching, restart).
  const progress = useProgressHost(layout);
  const [mouse] = useSetting("mouse");
  useMouseReporting(mouse);
  // Mouse events go to the shown view only, and to none while a dialog is open.
  const mouseFor = (m: Mode) => mouse && mode === m && !blocked && !modal;
  const quit = () => (confirmQuit ? setQuitAsked(true) : exit());
  const [gitRoot, setGitRoot] = useState<string | null>();
  // While a view shows a detail (full prompt, whole file, plan changes), Esc closes it instead of quitting.
  const [detailOpen, setDetailOpen] = useState<Record<Mode, boolean>>({
    chat: false,
    git: false,
    plan: false,
    sessions: false,
    settings: false,
    monitor: false,
  });
  const setDetail = (m: Mode) => (open: boolean) => setDetailOpen((d) => ({ ...d, [m]: open }));

  // An entry the Settings view is asked to select: by /cco:releases or a click on the top bar's update.
  const [settingsSelect, setSettingsSelect] = useState<{ key: string; at: number; ask?: boolean } | undefined>(() => (initialSelect ? { key: initialSelect, at: Date.now() } : undefined));
  const showView = (view: Mode | undefined, select?: string, ask?: boolean) => {
    if (view) setMode(view);
    if (select) setSettingsSelect({ key: select, at: Date.now(), ask });
  };
  // Requests of cco open: a view, and /cco:restart and /cco:update.
  const onRequest = (view: Mode | undefined, select?: string, action?: ViewerAction) => {
    showView(view, select);
    if (action === "restart") restartViewer();
    if (action === "update") checkForUpdate();
  };
  // The watcher keeps the first callback; the restart needs the view and session shown now.
  const request = useRef(onRequest);
  request.current = onRequest;
  useViewerControl({ cwd, claudePid, followActive: !sessionId, onView: (...args) => request.current(...args), onSessionEnd: exit });

  // The update check runs once at the start, unless the setting is off then.
  const [updateMode] = useState(() => readSettings().updateMode);
  const update = useUpdate({
    mode: updateMode,
    updatedTo,
    onOpen: () => showView("settings", "update"),
    // The viewer reopens where it is, running the new version's CLI.
    onRestart: (version) => {
      const where = placement ?? resolvePlacement(cwd, sessionOf(path));
      if (!moveViewer(cwd, mode, where, claudePid, version)) return false;
      exit();
      return true;
    },
  });

  // After an update: the notes of every version since the one run before, until closed.
  const whatsNewOpen = update.whatsNew.length > 0;
  // Views take no keys while a dialog of the app is open.
  const blocked = infoOpen || quitAsked || placementOpen || whatsNewOpen || progress.host.open;

  // update: auto: the check at the start found a newer version, so Settings shows it and asks to install it, once.
  const offered = useRef(false);
  useEffect(() => {
    if (!update.offer || offered.current) return;
    offered.current = true;
    showView("settings", "update", true);
  }, [update.offer]);

  // /cco:update: Settings on the update entry, a check now whatever the setting says, then the update found, asked for.
  const [updateChecked, setUpdateChecked] = useState<number>();
  const checkForUpdate = () => {
    showView("settings", "update");
    void update.recheck().then(() => setUpdateChecked(Date.now()));
  };
  useEffect(() => {
    if (updateChecked !== undefined && update.state.kind === "update" && !update.run) showView("settings", "update", true);
  }, [updateChecked]);
  useEffect(() => {
    if (initialAction === "update") checkForUpdate();
  }, []);

  // The process's session went on in another transcript: it is the process's session now.
  const { continuedFrom } = transcript;
  useEffect(() => {
    if (claudePid && !sessionId && continuedFrom && transcript.file) continueSession(cwd, claudePid, continuedFrom, transcript.file);
  }, [cwd, claudePid, sessionId, continuedFrom, transcript.file]);

  // Remember the shown view so the viewer reopens with it after a restart.
  useEffect(() => setViewerView(cwd, mode, claudePid), [cwd, mode, claudePid]);

  // Each session keeps its own last view: switching to another session (/resume) brings back its view,
  // and the view shown is recorded for the session shown.
  const shownPath = useRef(path);
  useEffect(() => {
    const id = sessionOf(path);
    if (path !== shownPath.current) {
      shownPath.current = path;
      const remembered = rememberView ? readSessionView(cwd, id) : undefined;
      const view = remembered && isViewShown(readSettings(), remembered) ? remembered : undefined;
      // Recorded on the next run, with the view switched.
      if (view && view !== mode) return setMode(view);
    }
    if (rememberView && id) saveSessionView(cwd, id, mode);
  }, [cwd, path, mode, rememberView]);

  useEffect(() => {
    repoRoot(cwd).then((r) => setGitRoot(r ?? null));
  }, [cwd]);

  /**
   * Deletes the project's marks, positions, per-session views and restore
   * state, then remounts the views so none keeps them in memory. Their
   * unmount would save positions again, so writes pause until the new ones are up.
   */
  /** Sessions: detaches this viewer from its Claude Code; the views remount for the project's newest session. */
  const detach = () => {
    if (!claudePid || !onDetach) return;
    detachViewer(cwd, claudePid, mode);
    onDetach(cwd);
  };
  /** Sessions: pairs this viewer with a running Claude Code process; false if a viewer runs for it already. */
  const pairWith = (target: PairTarget) => {
    if (!onPair || !pairViewer({ cwd, claudePid }, target)) return false;
    onPair(target.cwd, target.claudePid);
    return true;
  };
  /**
   * Sessions: this viewer (without a Claude Code) started one for a session, which runs now `where`
   * (`resumeForPairing`): the viewer reopens next to it, paired, in the chat.
   */
  const pairWithStarted = (target: PairTarget, where: string) => {
    writeTargetSession(target);
    if (moveViewer(target.cwd, "chat", resolvePlacement(target.cwd, target.sessionId), target.claudePid, undefined, where)) exit();
  };
  // Reset: restart, and /cco:restart. The viewer says so for a moment, then reopens where it is, running the CLI on disk now.
  const restarting = useRef(false);
  const restartViewer = () => {
    // A viewer of one session (--session) was not opened by cco open, which cannot reopen it.
    if (sessionId || restarting.current) return;
    restarting.current = true;
    const title = "Restart the viewer";
    progress.host.set("restart", { title, status: "running", text: "Restarting" });
    setTimeout(() => {
      if (moveViewer(cwd, mode, placement ?? resolvePlacement(cwd, sessionOf(path)), claudePid)) return exit();
      restarting.current = false;
      progress.host.set("restart", {
        title,
        status: "failed",
        text: "The viewer did not reopen",
        lines: [REOPEN_BY_HAND],
        onClose: () => progress.host.set("restart", undefined),
      });
    }, TIMING.restartDelay);
  };
  const resetProjectData = () => {
    suspendPositionWrites(true);
    clearProjectData(cwd);
    setGeneration((g) => g + 1);
  };
  useEffect(() => {
    if (generation > 0) suspendPositionWrites(false);
  }, [generation]);

  const finishReload = useCallback(
    (m: Mode) => setReloading((r) => (r?.mode === m && !r.done ? { mode: m, done: true } : r)),
    [],
  );
  useEffect(() => {
    if (!reloading?.done) return;
    const timer = setTimeout(() => setReloading(undefined), TIMING.reloaded);
    return () => clearTimeout(timer);
  }, [reloading]);
  // The transcript is read synchronously; it is loaded once it reports the reload.
  useEffect(() => {
    if (transcriptReload > 0 && transcript.loaded === transcriptReload) finishReload(reloading?.mode === "plan" ? "plan" : "chat");
  }, [transcript.loaded]);
  // A reload still running is not started again.
  const reload = () => {
    if (reloading && !reloading.done) return;
    stdout.write(REDRAW);
    setReloads((r) => ({ ...r, [mode]: r[mode] + 1 }));
    setReloading({ mode, done: false });
  };
  useReloadKey(reload, !(modal || typing || blocked));
  const reloadOf = (m: Mode) => ({
    count: reloads[m],
    status: reloading?.mode === m ? (reloading.done ? ("done" as const) : ("loading" as const)) : undefined,
    done: () => finishReload(m),
  });

  // The chosen place is remembered for the followed session; the viewer then reopens there and quits.
  const choosePlacement = (choice: Placement) => {
    const id = sessionOf(path);
    if (id) saveSessionPlacement(cwd, id, choice);
    if (choice !== placement && moveViewer(cwd, mode, choice, claudePid)) exit();
  };

  useInput((input, key) => {
    if (modal || typing || quitAsked || placementOpen || whatsNewOpen || progress.host.open) return;
    // The info dialog is modal: it takes all keys until it is closed.
    if (infoOpen) {
      if (input === "i" || key.escape) setInfoOpen(false);
      else if (input === "q") quit();
      return;
    }
    // A click on a tab of the top bar switches to its view.
    if (input.startsWith("[<")) {
      if (!mouse) return;
      const click = parseMouse(input).find((e) => e.kind === "click" && e.y === 0);
      const view = click && tabAt(click.x, readSettings(), mode);
      if (view && view !== mode) setMode(view);
      return;
    }
    if (input === "q" || (key.escape && !detailOpen[mode])) quit();
    else if (input === "i") setInfoOpen(true);
    // Only a viewer that follows the live session moves; one started with --session stays.
    else if (input === "p" && !sessionId) setPlacementOpen(true);
    // Tab and Shift+Tab step through the shown views, wrapping around.
    else if (key.tab) setMode(nextShownView(readSettings(), mode, key.shift ? -1 : 1));
    // A hidden view's key does nothing; its number stays reserved.
    else if (VIEW_KEYS[input] && isViewShown(readSettings(), VIEW_KEYS[input])) setMode(VIEW_KEYS[input]);
  });

  // All views stay mounted so the chat keeps following the transcript while hidden.
  return (
    <FocusContext.Provider value={focused}>
    <UpdateContext.Provider value={update}>
    <ProgressHostProvider host={progress.host}>
    <SessionColorContext.Provider value={transcript.color}>
      <Box flexDirection="column" width={layout.columns} height={layout.rows}>
        <Fragment key={generation}>
        <Box display={mode === "chat" ? "flex" : "none"}>
          <ReloadContext.Provider value={reloadOf("chat")}>
          <MouseContext.Provider value={mouseFor("chat")}>
          <ChatView
            cwd={cwd}
            path={path}
            transcript={transcript}
            layout={layout}
            active={mode === "chat" && !blocked}
            onPromptOpen={setDetail("chat")}
            onTyping={setTyping}
            onModal={setModal}
            liveSession={!sessionId}
          />
          </MouseContext.Provider>
          </ReloadContext.Provider>
        </Box>
        <Box display={mode === "git" ? "flex" : "none"}>
          <ReloadContext.Provider value={reloadOf("git")}>
          <MouseContext.Provider value={mouseFor("git")}>
          <GitView
            cwd={cwd}
            layout={layout}
            active={mode === "git" && !blocked}
            onFileOpen={setDetail("git")}
            onTyping={setTyping}
          />
          </MouseContext.Provider>
          </ReloadContext.Provider>
        </Box>
        <Box display={mode === "plan" ? "flex" : "none"}>
          <ReloadContext.Provider value={reloadOf("plan")}>
          <MouseContext.Provider value={mouseFor("plan")}>
          <PlanView
            cwd={cwd}
            plans={transcript.plans}
            planMode={transcript.planMode}
            hasSession={path !== undefined}
            layout={layout}
            active={mode === "plan" && !blocked}
            onDiffOpen={setDetail("plan")}
            onTyping={setTyping}
          />
          </MouseContext.Provider>
          </ReloadContext.Provider>
        </Box>
        <Box display={mode === "sessions" ? "flex" : "none"}>
          <ReloadContext.Provider value={reloadOf("sessions")}>
          <MouseContext.Provider value={mouseFor("sessions")}>
          <SessionsView
            cwd={cwd}
            activePath={path}
            layout={layout}
            visible={mode === "sessions"}
            active={mode === "sessions" && !blocked}
            onTrashOpen={setDetail("sessions")}
            onTyping={setTyping}
            onModal={setModal}
            // Any viewer attaches to another Claude Code, leaving its own if it has one.
            onPair={onPair ? pairWith : undefined}
            onPairStarted={onPair ? pairWithStarted : undefined}
            onDetach={claudePid !== undefined && !sessionId && onDetach ? detach : undefined}
            // A viewer of its Claude Code's live session can continue another session there (/resume).
            paired={
              claudePid !== undefined && !sessionId
                ? { claudePid, empty: isEmptySession(transcript.turns), placement: placement ?? resolvePlacement(cwd, sessionOf(path)) }
                : undefined
            }
          />
          </MouseContext.Provider>
          </ReloadContext.Provider>
        </Box>
        <Box display={mode === "settings" ? "flex" : "none"}>
          <ReloadContext.Provider value={reloadOf("settings")}>
          <MouseContext.Provider value={mouseFor("settings")}>
          <SettingsView
            cwd={cwd}
            layout={layout}
            active={mode === "settings" && !blocked}
            onModal={setModal}
            onTyping={setTyping}
            onResetData={resetProjectData}
            onRestart={sessionId ? undefined : restartViewer}
            select={settingsSelect}
          />
          </MouseContext.Provider>
          </ReloadContext.Provider>
        </Box>
        <Box display={mode === "monitor" ? "flex" : "none"}>
          <ReloadContext.Provider value={reloadOf("monitor")}>
          <MouseContext.Provider value={mouseFor("monitor")}>
          <MonitorView cwd={cwd} layout={layout} visible={mode === "monitor"} active={mode === "monitor" && !blocked} onTyping={setTyping} />
          </MouseContext.Provider>
          </ReloadContext.Provider>
        </Box>
        </Fragment>
        {whatsNewOpen && <WhatsNewDialog layout={layout} releases={update.whatsNew} from={update.whatsNewFrom} onClose={update.closeWhatsNew} />}
        {infoOpen && <InfoDialog layout={layout} mode={mode} cwd={cwd} path={path} gitRoot={gitRoot} />}
        {placementOpen && (
          <PlacementDialog
            layout={layout}
            current={placement}
            canMove={detectTerminal() !== undefined}
            onChoose={choosePlacement}
            onClose={() => setPlacementOpen(false)}
          />
        )}
        {quitAsked && (
          <ConfirmDialog
            layout={layout}
            confirmation={{
              title: "Quit cco?",
              lines: ["The pane closes; a /cco:… command opens it again."],
              onConfirm: exit,
            }}
            onClose={() => setQuitAsked(false)}
          />
        )}
        {progress.dialog}
      </Box>
    </SessionColorContext.Provider>
    </ProgressHostProvider>
    </UpdateContext.Provider>
    </FocusContext.Provider>
  );
}
