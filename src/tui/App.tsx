import { Box, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { setViewerView } from "../viewer.js";
import { ChatView } from "./ChatView.js";
import { FocusContext, useTerminalFocus } from "./focus.js";
import { GitView } from "./GitView.js";
import { useLayout, type Mode } from "./layout.js";
import { useViewerControl } from "./useViewerControl.js";

interface Props {
  cwd: string;
  sessionId?: string;
  initialMode?: Mode;
  /** The pane was opened without taking the focus (focus stayed in Claude Code). */
  unfocused?: boolean;
}

export function App({ cwd, sessionId, initialMode = "chat", unfocused = false }: Props) {
  const { exit } = useApp();
  const layout = useLayout();
  const focused = useTerminalFocus(!unfocused);
  const [mode, setMode] = useState<Mode>(initialMode);
  // While a view shows a detail (full prompt, whole file), Esc closes it instead of quitting.
  const [detailOpen, setDetailOpen] = useState<Record<Mode, boolean>>({ chat: false, git: false });
  const setDetail = (m: Mode) => (open: boolean) => setDetailOpen((d) => ({ ...d, [m]: open }));

  useViewerControl({ cwd, followActive: !sessionId, onView: setMode, onSessionEnd: exit });

  // Remember the shown view so the viewer reopens with it after a restart.
  useEffect(() => setViewerView(cwd, mode), [cwd, mode]);

  useInput((input, key) => {
    if (input === "q" || (key.escape && !detailOpen[mode])) exit();
    else if (input === "1") setMode("chat");
    else if (input === "2") setMode("git");
  });

  // Both views stay mounted so the chat keeps following the transcript while hidden.
  return (
    <FocusContext.Provider value={focused}>
      <Box display={mode === "chat" ? "flex" : "none"}>
        <ChatView
          cwd={cwd}
          sessionId={sessionId}
          layout={layout}
          active={mode === "chat"}
          onPromptOpen={setDetail("chat")}
        />
      </Box>
      <Box display={mode === "git" ? "flex" : "none"}>
        <GitView cwd={cwd} layout={layout} active={mode === "git"} onFileOpen={setDetail("git")} />
      </Box>
    </FocusContext.Provider>
  );
}
