import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { useEffect, useRef, useState } from "react";
import {
  activeFile,
  claudeFile,
  findLatestTranscript,
  readActive,
  readJson,
  transcriptForSession,
  type ActiveSession,
} from "../transcript/locate.js";
import { predecessors } from "../transcript/continuation.js";
import { TranscriptParser, type AgentRun, type Plan, type PlanModeState, type Turn } from "../transcript/parse.js";
import { FileTail, watchFile } from "../transcript/tail.js";

/**
 * Resolves which transcript to show. A fixed session wins; then the session of
 * the viewer's own Claude Code process (`claudePid`); otherwise the hook's
 * active-session file, falling back to the newest transcript of the project.
 * A change of `reload` resolves it again at once.
 */
export function useSessionPath(cwd: string, sessionId?: string, claudePid?: number, reload = 0): string | undefined {
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
    if (reload > 0) setPath((prev) => resolve() ?? prev);
  }, [reload]);

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
  /** The session colour set with /color, as Claude Code names it. */
  color?: string;
  /**
   * The transcript read now: `path`, or the one the session continued in
   * (`continued-in`, e.g. after /compact sent it to the background).
   */
  file?: string;
  /** The transcript `file` continued, once the session moved on. */
  continuedFrom?: string;
  /** Increments on every change. */
  version: number;
  /** The `reload` the transcript was last read afresh for. */
  loaded?: number;
}

/** One session read across its transcripts: the one opened, then those it continued in. */
interface Followed {
  parser: TranscriptParser;
  tail?: FileTail;
  file?: string;
  /** The file read before `file`, which continued in it. */
  from?: string;
  /** Session ids already read, so a loop of `continued-in` entries ends. */
  visited: Set<string>;
}

const sessionIdOf = (file: string) => basename(file, ".jsonl");

/**
 * Parses and follows a transcript. When the session continues in another
 * transcript, it reads on there with the same parser, so the turns so far stay.
 * A change of `reload` reads it all again with a new parser; the turns read
 * so far stay shown until the new ones replace them.
 */
export function useTranscript(path: string | undefined, reload = 0): Transcript {
  const [state, setState] = useState<Transcript>({ turns: [], plans: [], agents: [], version: 0 });
  const followed = useRef<Followed | undefined>(undefined);
  const loaded = useRef(reload);

  useEffect(() => {
    const current = followed.current;
    const fresh = reload !== loaded.current;
    loaded.current = reload;
    if (current && path && !fresh) {
      // Catch up first: the session may have moved on to `path`, and then its turns stay.
      current.tail?.poll();
      if (current.file === path) return;
    }
    void current?.tail?.stop();
    followed.current = undefined;
    if (!fresh) setState({ turns: [], plans: [], agents: [], file: path, version: 0 });
    if (!path) {
      if (fresh) setState((s) => ({ turns: [], plans: [], agents: [], version: s.version + 1, loaded: reload }));
      return;
    }

    const f: Followed = { parser: new TranscriptParser({ dedupe: true }), visited: new Set([sessionIdOf(path)]) };
    followed.current = f;
    const publish = (file: string) =>
      setState((s) => ({
        turns: [...f.parser.turns],
        plans: f.parser.plans.map((p) => ({ ...p })),
        planMode: f.parser.planMode && { ...f.parser.planMode },
        agents: [...f.parser.agents],
        title: f.parser.title,
        color: f.parser.color,
        file,
        continuedFrom: f.from,
        version: s.version + 1,
        loaded: s.loaded,
      }));
    const follow = (file: string) => {
      f.file = file;
      f.parser.nextFile();
      const tail = new FileTail(file, (chunk) => {
        const turns = f.parser.turns.length;
        const agents = f.parser.agents.length;
        if (f.parser.push(chunk)) {
          // Images and subagents are looked up next to the transcript a turn came from.
          for (const t of f.parser.turns.slice(turns)) t.transcript = file;
          for (const a of f.parser.agents.slice(agents)) a.transcript = file;
          publish(file);
        }
        const next = f.parser.continuedIn;
        if (next && !f.visited.has(next)) {
          f.visited.add(next);
          void tail.stop();
          f.from = file;
          follow(join(dirname(file), `${next}.jsonl`));
          publish(f.file!);
        }
      });
      f.tail = tail;
      tail.start();
    };
    // A session that continued from other transcripts (e.g. /resume after /compact moved it) starts with their turns.
    for (const earlier of predecessors(path)) {
      f.visited.add(sessionIdOf(earlier));
      f.parser.nextFile();
      try {
        f.parser.push(readFileSync(earlier, "utf8") + "\n");
      } catch {
        continue;
      }
      for (const t of f.parser.turns) t.transcript ??= earlier;
      for (const a of f.parser.agents) a.transcript ??= earlier;
    }
    if (f.parser.turns.length > 0) publish(path);
    follow(path);
    // The new parser replaces the turns shown so far even when the file had none.
    if (fresh) {
      publish(f.file!);
      setState((s) => ({ ...s, loaded: reload }));
    }
  }, [path, reload]);

  useEffect(() => () => void followed.current?.tail?.stop(), []);

  return state;
}
