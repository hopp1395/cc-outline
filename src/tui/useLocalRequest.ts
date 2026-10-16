import { useEffect, useState } from "react";
import { readLocalRequest, type LocalRequest } from "../localRequest.js";
import { TIMING } from "../timing.js";
import { inClaudeDir } from "../transcript/locate.js";

/**
 * What a session of this machine waits for, as its hooks recorded it (`readLocalRequest`), read every
 * `TIMING.activityPoll` while it `waits`; `account` is the config folder of another account's session.
 */
export function useLocalRequest(sessionId: string | undefined, transcript: string | undefined, waits: boolean, account?: string): LocalRequest | undefined {
  const [request, setRequest] = useState<LocalRequest>();
  useEffect(() => {
    if (!sessionId || !waits) return setRequest(undefined);
    const read = () => {
      const next = account ? inClaudeDir(account, () => readLocalRequest(sessionId, transcript)) : readLocalRequest(sessionId, transcript);
      setRequest((prev) => (prev?.at === next?.at && prev?.sessionId === next?.sessionId ? prev : next));
    };
    read();
    const timer = setInterval(read, TIMING.activityPoll);
    return () => clearInterval(timer);
  }, [sessionId, transcript, waits, account]);
  return request;
}
