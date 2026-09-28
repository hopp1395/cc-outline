import { existsSync } from "node:fs";
import { useEffect, useState } from "react";
import {
  activeFile,
  claudeFile,
  findLatestTranscript,
  readActive,
  readJson,
  transcriptForSession,
  type ActiveSession,
} from "../transcript/locate.js";
import { TranscriptParser, type AgentRun, type Plan, type PlanModeState, type Turn } from "../transcript/parse.js";
import { FileTail, watchFile } from "../transcript/tail.js";

/**
 * Resolves which transcript to show. A fixed session wins; then the session of
 * the viewer's own Claude Code process (`claudePid`); otherwise the hook's
 * active-session file, falling back to the newest transcript of the project.
 */
export function useSessionPath(cwd: string, sessionId?: string, claudePid?: number): string | undefined {
  const resolve = () => {
    if (sessionId) return transcriptForSession(cwd, sessionId);
    const own = claudePid ? readJson<ActiveSession>(claudeFile(cwd, claudePid)) : undefined;
    if (own) return own.transcript_path;
    // A new session's transcript is only created with its first message; follow
    // the path anyway so the view switches instead of lingering on the old session.
    const active = readActive(cwd);
    if (active && !active.ended) return active.transcript_path;
    return findLatestTranscript(cwd);
  };
  const [path, setPath] = useState(resolve);

  useEffect(() => {
    if (sessionId) return;
    const update = () => setPath((prev) => resolve() ?? prev);
    const watcher = watchFile(claudePid ? claudeFile(cwd, claudePid) : activeFile(cwd), update);
    // Without the hook installed, pick up new sessions (e.g. after /clear) by polling.
    const timer = setInterval(() => {
      if (!existsSync(activeFile(cwd))) update();
    }, 2000);
    return () => {
      clearInterval(timer);
      void watcher.close();
    };
  }, [cwd, sessionId, claudePid]);

  return path;
}

export interface Transcript {
  turns: Turn[];
  plans: Plan[];
  /** Plan mode while it is on: its plan file, for the plan being written. */
  planMode?: PlanModeState;
  /** Subagents started in the session; updated in place, `version` changes with them. */
  agents: AgentRun[];
  /** The session title (/rename, else Claude Code's own), once the transcript has one. */
  title?: string;
  /** Increments on every change. */
  version: number;
}

/** Parses and follows a transcript. */
export function useTranscript(path: string | undefined): Transcript {
  const [state, setState] = useState<Transcript>({ turns: [], plans: [], agents: [], version: 0 });

  useEffect(() => {
    const parser = new TranscriptParser();
    setState({ turns: [], plans: [], agents: [], version: 0 });
    if (!path) return;
    const tail = new FileTail(path, (chunk) => {
      if (parser.push(chunk)) {
        setState((s) => ({
          turns: [...parser.turns],
          plans: parser.plans.map((p) => ({ ...p })),
          planMode: parser.planMode && { ...parser.planMode },
          agents: [...parser.agents],
          title: parser.title,
          version: s.version + 1,
        }));
      }
    });
    tail.start();
    return () => void tail.stop();
  }, [path]);

  return state;
}
