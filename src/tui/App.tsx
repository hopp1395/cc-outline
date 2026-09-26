import { Box, useApp, useInput } from "ink";
import { useState } from "react";
import { ChatView } from "./ChatView.js";
import { GitView } from "./GitView.js";
import { useLayout, type Mode } from "./layout.js";
import { useViewerControl } from "./useViewerControl.js";

interface Props {
  cwd: string;
  sessionId?: string;
  initialMode?: Mode;
}

export function App({ cwd, sessionId, initialMode = "chat" }: Props) {
  const { exit } = useApp();
  const layout = useLayout();
  const [mode, setMode] = useState<Mode>(initialMode);

  useViewerControl({ cwd, followActive: !sessionId, onView: setMode, onSessionEnd: exit });

  useInput((input, key) => {
    if (input === "q" || key.escape) exit();
    else if (input === "1") setMode("chat");
    else if (input === "2") setMode("git");
  });

  // Both views stay mounted so the chat keeps following the transcript while hidden.
  return (
    <>
      <Box display={mode === "chat" ? "flex" : "none"}>
        <ChatView cwd={cwd} sessionId={sessionId} layout={layout} active={mode === "chat"} />
      </Box>
      <Box display={mode === "git" ? "flex" : "none"}>
        <GitView cwd={cwd} layout={layout} active={mode === "git"} />
      </Box>
    </>
  );
}
