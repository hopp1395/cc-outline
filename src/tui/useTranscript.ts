import { existsSync } from "node:fs";
import { useEffect, useState } from "react";
import {
  activeFile,
  findLatestTranscript,
  readActive,
  transcriptForSession,
} from "../transcript/locate.js";
import { TranscriptParser, type Turn } from "../transcript/parse.js";
import { FileTail, watchFile } from "../transcript/tail.js";

/**
 * Resolves which transcript to show. A fixed session wins; otherwise the hook's
 * active-session file, falling back to the newest transcript of the project.
 */
export function useSessionPath(cwd: string, sessionId?: string): string | undefined {
  const resolve = () => {
    if (sessionId) return transcriptForSession(cwd, sessionId);
    const active = readActive(cwd);
    if (active && existsSync(active.transcript_path)) return active.transcript_path;
    return findLatestTranscript(cwd);
  };
  const [path, setPath] = useState(resolve);

  useEffect(() => {
    if (sessionId) return;
    const update = () => setPath((prev) => resolve() ?? prev);
    const watcher = watchFile(activeFile(cwd), update);
    // Without the hook installed, pick up new sessions (e.g. after /clear) by polling.
    const timer = setInterval(() => {
      if (!existsSync(activeFile(cwd))) update();
    }, 2000);
    return () => {
      clearInterval(timer);
      void watcher.close();
    };
  }, [cwd, sessionId]);

  return path;
}

/** Parses and follows a transcript. `version` increments on every change. */
export function useTranscript(path: string | undefined): { turns: Turn[]; version: number } {
  const [state, setState] = useState<{ turns: Turn[]; version: number }>({ turns: [], version: 0 });

  useEffect(() => {
    const parser = new TranscriptParser();
    setState({ turns: [], version: 0 });
    if (!path) return;
    const tail = new FileTail(path, (chunk) => {
      if (parser.push(chunk)) {
        setState((s) => ({ turns: [...parser.turns], version: s.version + 1 }));
      }
    });
    tail.start();
    return () => void tail.stop();
  }, [path]);

  return state;
}
