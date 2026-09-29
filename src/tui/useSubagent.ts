import { useEffect, useState } from "react";
import { TranscriptParser, type AgentRun, type Turn } from "../transcript/parse.js";
import { subagentFile } from "../transcript/subagents.js";
import { FileTail } from "../transcript/tail.js";
import { useReload } from "./reload.js";

/** How often to look for a subagent's transcript that is not there yet. */
const FIND_MS = 1000;

export interface Subagent {
  /** The subagent's own transcript; undefined while it is not found. */
  file?: string;
  /** Its conversation: the task, then what it did. */
  turns: Turn[];
  version: number;
}

/**
 * Reads and follows the transcript of `agent` (of the session in
 * `transcript`) while it is shown. Undefined `agent`: nothing is read.
 * A reload of the view (F5) reads it again.
 */
export function useSubagent(transcript: string | undefined, agent: AgentRun | undefined): Subagent {
  const { count } = useReload();
  const [state, setState] = useState<Subagent>({ turns: [], version: 0 });
  const agentKey = agent ? `${agent.id}:${agent.agentId ?? ""}` : undefined;

  useEffect(() => {
    setState({ turns: [], version: 0 });
    if (!transcript || !agent) return;
    let tail: FileTail | undefined;
    let finder: NodeJS.Timeout | undefined;
    const follow = (file: string) => {
      const parser = new TranscriptParser({ sidechains: true });
      tail = new FileTail(file, (chunk) => {
        if (parser.push(chunk)) setState((s) => ({ file, turns: [...parser.turns], version: s.version + 1 }));
      });
      tail.start();
      setState((s) => ({ ...s, file }));
    };
    const find = () => {
      const file = subagentFile(transcript, agent);
      if (!file) return false;
      clearInterval(finder);
      follow(file);
      return true;
    };
    if (!find()) finder = setInterval(find, FIND_MS);
    return () => {
      clearInterval(finder);
      void tail?.stop();
    };
  }, [transcript, agentKey, count]);

  return state;
}
