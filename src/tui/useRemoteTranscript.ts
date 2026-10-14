import { useEffect, useState } from "react";
import { listEvents, listSessions, type RemoteEvent, type RemoteSession } from "../remote/api.js";
import { describeRemoteError } from "../remote/index.js";
import { pendingRequests, type PendingRequest } from "../remote/pending.js";
import { toTranscript } from "../remote/toTranscript.js";
import { TIMING } from "../timing.js";
import { TranscriptParser } from "../transcript/parse.js";
import type { Transcript } from "./useTranscript.js";

/** A remote session as its viewer follows it: the transcript its events make, and what claude.ai says of it. */
export interface RemoteTranscript extends Transcript {
  /** The session as listed (title, worker and connection status), once read. */
  session?: RemoteSession;
  /** What the worker waits for, oldest first. */
  pending: PendingRequest[];
  /** Why the last read failed; the turns read so far stay. */
  error?: string;
  /** Older events than the first read were left out. */
  truncated: boolean;
}

/** How often the list (title, status) is read, in polls of the events. */
const LIST_EVERY = 3;

/**
 * Follows the remote session `id` like `useTranscript` follows a file: its newest events at once, then every
 * `TIMING.remotePoll` the ones added since, each once (by `sequence_num`), through the transcript parser. A change
 * of `reload` reads it all again; the turns stay shown until then.
 */
export function useRemoteTranscript(id: string | undefined, reload = 0): RemoteTranscript {
  const [state, setState] = useState<RemoteTranscript>({ turns: [], plans: [], agents: [], version: 0, pending: [], truncated: false });
  useEffect(() => {
    if (!id) return;
    const parser = new TranscriptParser({ dedupe: true });
    const events: RemoteEvent[] = [];
    let last = -1;
    let truncated = false;
    let session: RemoteSession | undefined;
    let polls = 0;
    let cancelled = false;
    let busy = false;
    let first = true;
    // Published only when something changed: a poll every second must not re-render the chat each time.
    let shown = "";
    const publish = (error?: string) => {
      const now = `${last}|${session?.title}|${session?.workerStatus}|${session?.connectionStatus}|${error}`;
      if (now === shown) return;
      shown = now;
      setState((s) => ({
        turns: [...parser.turns],
        plans: parser.plans.map((p) => ({ ...p })),
        planMode: parser.planMode && { ...parser.planMode },
        agents: [...parser.agents],
        title: session?.title ?? parser.title,
        color: parser.color,
        version: s.version + 1,
        loaded: reload,
        session,
        pending: pendingRequests(events),
        error,
        truncated,
      }));
    };
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        if (polls++ % LIST_EVERY === 0) session = (await listSessions()).find((s) => s.id === id) ?? session;
        const batch = await listEvents(id);
        if (cancelled) return;
        // The first read holds the newest events only; later ones come with each poll.
        if (first) truncated = batch.truncated;
        first = false;
        const fresh = batch.events.filter((e) => e.sequence > last);
        if (fresh.length) {
          last = fresh.at(-1)!.sequence;
          events.push(...fresh);
          const { lines } = toTranscript(fresh);
          if (lines.length) parser.push(lines.join("\n") + "\n");
        }
        publish();
      } catch (err) {
        if (!cancelled) publish(describeRemoteError(err));
      } finally {
        busy = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), TIMING.remotePoll);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, reload]);
  return state;
}
