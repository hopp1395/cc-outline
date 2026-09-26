import { Box, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { repoRoot } from "../git/git.js";
import { setViewerView } from "../viewer.js";
import { ChatView } from "./ChatView.js";
import { FocusContext, useTerminalFocus } from "./focus.js";
import { GitView } from "./GitView.js";
import { InfoDialog } from "./InfoDialog.js";
import { useLayout, type Mode } from "./layout.js";
import { PlanView } from "./PlanView.js";
import { SessionsView } from "./SessionsView.js";
import { useSessionPath, useTranscript } from "./useTranscript.js";
import { useViewerControl } from "./useViewerControl.js";

interface Props {
  cwd: string;
  sessionId?: string;
  initialMode?: Mode;
  /** The pane was opened without taking the focus (focus stayed in Claude Code). */
  unfocused?: boolean;
}

const VIEW_KEYS: Record<string, Mode> = { "1": "chat", "2": "git", "3": "plan", "4": "sessions" };

export function App({ cwd, sessionId, initialMode = "chat", unfocused = false }: Props) {
  const { exit } = useApp();
  const layout = useLayout();
  const focused = useTerminalFocus(!unfocused);
  const path = useSessionPath(cwd, sessionId);
  // Parsed once for the chat and the plan view.
  const transcript = useTranscript(path);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [infoOpen, setInfoOpen] = useState(false);
  const [gitRoot, setGitRoot] = useState<string | null>();
  // While a view shows a detail (full prompt, whole file, plan changes), Esc closes it instead of quitting.
  const [detailOpen, setDetailOpen] = useState<Record<Mode, boolean>>({
    chat: false,
    git: false,
    plan: false,
    sessions: false,
  });
  const setDetail = (m: Mode) => (open: boolean) => setDetailOpen((d) => ({ ...d, [m]: open }));

  useViewerControl({ cwd, followActive: !sessionId, onView: setMode, onSessionEnd: exit });

  // Remember the shown view so the viewer reopens with it after a restart.
  useEffect(() => setViewerView(cwd, mode), [cwd, mode]);

  useEffect(() => {
    repoRoot(cwd).then((r) => setGitRoot(r ?? null));
  }, [cwd]);

  useInput((input, key) => {
    // The info dialog is modal: it takes all keys until it is closed.
    if (infoOpen) {
      if (input === "i" || key.escape) setInfoOpen(false);
      else if (input === "q") exit();
      return;
    }
    if (input === "q" || (key.escape && !detailOpen[mode])) exit();
    else if (input === "i") setInfoOpen(true);
    else if (VIEW_KEYS[input]) setMode(VIEW_KEYS[input]);
  });

  // All views stay mounted so the chat keeps following the transcript while hidden.
  return (
    <FocusContext.Provider value={focused}>
      <Box flexDirection="column" width={layout.columns} height={layout.rows}>
        <Box display={mode === "chat" ? "flex" : "none"}>
          <ChatView
            cwd={cwd}
            path={path}
            transcript={transcript}
            layout={layout}
            active={mode === "chat" && !infoOpen}
            onPromptOpen={setDetail("chat")}
          />
        </Box>
        <Box display={mode === "git" ? "flex" : "none"}>
          <GitView
            cwd={cwd}
            layout={layout}
            active={mode === "git" && !infoOpen}
            onFileOpen={setDetail("git")}
          />
        </Box>
        <Box display={mode === "plan" ? "flex" : "none"}>
          <PlanView
            cwd={cwd}
            plans={transcript.plans}
            hasSession={path !== undefined}
            layout={layout}
            active={mode === "plan" && !infoOpen}
            onDiffOpen={setDetail("plan")}
          />
        </Box>
        <Box display={mode === "sessions" ? "flex" : "none"}>
          <SessionsView
            cwd={cwd}
            activePath={path}
            layout={layout}
            visible={mode === "sessions"}
            active={mode === "sessions" && !infoOpen}
          />
        </Box>
        {infoOpen && <InfoDialog layout={layout} mode={mode} cwd={cwd} path={path} gitRoot={gitRoot} />}
      </Box>
    </FocusContext.Provider>
  );
}
