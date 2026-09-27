import { Box, useApp, useInput } from "ink";
import { basename } from "node:path";
import { useEffect, useRef, useState } from "react";
import { repoRoot } from "../git/git.js";
import { detectTerminal, moveViewer } from "../open.js";
import { readSessionView, saveSessionPlacement, saveSessionView } from "../sessionViews.js";
import { isViewShown, nextShownView, readSettings, shownView, type Placement } from "../settings.js";
import { setViewerView } from "../viewer.js";
import { ChatView } from "./ChatView.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { FocusContext, useTerminalFocus } from "./focus.js";
import { GitView } from "./GitView.js";
import { InfoDialog } from "./InfoDialog.js";
import { MonitorView } from "./MonitorView.js";
import { MouseContext, useMouseReporting } from "./mouse.js";
import { PlacementDialog } from "./PlacementDialog.js";
import { useLayout, type Mode } from "./layout.js";
import { PlanView } from "./PlanView.js";
import { SessionsView } from "./SessionsView.js";
import { SettingsView } from "./SettingsView.js";
import { useSetting } from "./useSetting.js";
import { useSessionPath, useTranscript } from "./useTranscript.js";
import { useViewerControl } from "./useViewerControl.js";

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
}

const VIEW_KEYS: Record<string, Mode> = { "1": "chat", "2": "git", "3": "plan", "4": "sessions", "5": "monitor", "6": "settings" };

const sessionOf = (path?: string) => (path ? basename(path, ".jsonl") : undefined);

export function App({ cwd, sessionId, initialMode, unfocused = false, claudePid, placement }: Props) {
  const { exit } = useApp();
  const layout = useLayout();
  const focused = useTerminalFocus(!unfocused);
  const path = useSessionPath(cwd, sessionId, claudePid);
  // Parsed once for the chat and the plan view.
  const transcript = useTranscript(path);
  const [rememberView] = useSetting("rememberView");
  // An explicit --view opens its view even when hidden; a remembered or default one only if shown.
  const [mode, setMode] = useState<Mode>(() => {
    const settings = readSettings();
    return initialMode ?? shownView(settings, (settings.rememberView ? readSessionView(cwd, sessionOf(path)) : undefined) ?? "chat");
  });
  const [infoOpen, setInfoOpen] = useState(false);
  // p: where the viewer runs (right, left, own window).
  const [placementOpen, setPlacementOpen] = useState(false);
  // A view's confirmation dialog takes all keys while it is open.
  const [modal, setModal] = useState(false);
  // q or Esc asks before quitting; the viewer still closes by itself when the session ends.
  const [quitAsked, setQuitAsked] = useState(false);
  const [confirmQuit] = useSetting("confirmQuit");
  const [mouse] = useSetting("mouse");
  useMouseReporting(mouse);
  // Mouse events go to the shown view only, and to none while a dialog is open.
  const mouseFor = (m: Mode) => mouse && mode === m && !blocked && !modal;
  const quit = () => (confirmQuit ? setQuitAsked(true) : exit());
  // Views take no keys while a dialog of the app is open.
  const blocked = infoOpen || quitAsked || placementOpen;
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

  useViewerControl({ cwd, claudePid, followActive: !sessionId, onView: setMode, onSessionEnd: exit });

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

  // The chosen place is remembered for the followed session; the viewer then reopens there and quits.
  const choosePlacement = (choice: Placement) => {
    const id = sessionOf(path);
    if (id) saveSessionPlacement(cwd, id, choice);
    if (choice !== placement && moveViewer(cwd, mode, choice, claudePid)) exit();
  };

  useInput((input, key) => {
    if (modal || quitAsked || placementOpen) return;
    // The info dialog is modal: it takes all keys until it is closed.
    if (infoOpen) {
      if (input === "i" || key.escape) setInfoOpen(false);
      else if (input === "q") quit();
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
      <Box flexDirection="column" width={layout.columns} height={layout.rows}>
        <Box display={mode === "chat" ? "flex" : "none"}>
          <MouseContext.Provider value={mouseFor("chat")}>
          <ChatView
            cwd={cwd}
            path={path}
            transcript={transcript}
            layout={layout}
            active={mode === "chat" && !blocked}
            onPromptOpen={setDetail("chat")}
            liveSession={!sessionId}
          />
          </MouseContext.Provider>
        </Box>
        <Box display={mode === "git" ? "flex" : "none"}>
          <MouseContext.Provider value={mouseFor("git")}>
          <GitView
            cwd={cwd}
            layout={layout}
            active={mode === "git" && !blocked}
            onFileOpen={setDetail("git")}
          />
          </MouseContext.Provider>
        </Box>
        <Box display={mode === "plan" ? "flex" : "none"}>
          <MouseContext.Provider value={mouseFor("plan")}>
          <PlanView
            cwd={cwd}
            plans={transcript.plans}
            planMode={transcript.planMode}
            hasSession={path !== undefined}
            layout={layout}
            active={mode === "plan" && !blocked}
            onDiffOpen={setDetail("plan")}
          />
          </MouseContext.Provider>
        </Box>
        <Box display={mode === "sessions" ? "flex" : "none"}>
          <MouseContext.Provider value={mouseFor("sessions")}>
          <SessionsView
            cwd={cwd}
            activePath={path}
            layout={layout}
            visible={mode === "sessions"}
            active={mode === "sessions" && !blocked}
            onTrashOpen={setDetail("sessions")}
            onModal={setModal}
          />
          </MouseContext.Provider>
        </Box>
        <Box display={mode === "settings" ? "flex" : "none"}>
          <MouseContext.Provider value={mouseFor("settings")}>
          <SettingsView cwd={cwd} layout={layout} active={mode === "settings" && !blocked} onModal={setModal} />
          </MouseContext.Provider>
        </Box>
        <Box display={mode === "monitor" ? "flex" : "none"}>
          <MouseContext.Provider value={mouseFor("monitor")}>
          <MonitorView cwd={cwd} layout={layout} visible={mode === "monitor"} active={mode === "monitor" && !blocked} />
          </MouseContext.Provider>
        </Box>
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
      </Box>
    </FocusContext.Provider>
  );
}
