import { SessionReader, type SessionSummary } from "../transcript/sessions.js";
import { listEvents, listSessions, type RemoteSession } from "./api.js";
import { RemoteError } from "./credentials.js";
import { toTranscript } from "./toTranscript.js";

/** Where the session is shown on claude.ai (and in the Claude app). */
export const remoteUrl = (id: string) => `https://claude.ai/code/${id}`;

/** The stand-in for the transcript path: its folder names where the session comes from (the list shows it as the project). */
export const remotePath = (id: string) => `claude.ai/${id}.jsonl`;

/** What the list shows of a session before its events are read: title, times and status. */
export function remoteSummary(s: RemoteSession): SessionSummary {
  return {
    id: s.id,
    path: remotePath(s.id),
    title: s.title,
    prompts: [],
    plans: [],
    files: [],
    start: s.createdAt,
    end: s.lastEventAt ?? s.createdAt,
    modified: s.lastEventAt ?? s.createdAt,
    remote: { workerStatus: s.workerStatus, connectionStatus: s.connectionStatus, kind: s.environmentKind, userMessages: s.userMessageCount, loaded: false, refs: s.refs.filter((r) => r !== s.id), pending: s.pending },
  };
}

/** What a failure of the remote API says in the top bar, short. */
export function describeRemoteError(err: unknown): string {
  return err instanceof RemoteError ? err.message : `remote sessions failed: ${(err as Error).message}`;
}

/** The remote sessions of one account, listed and, one at a time, read through their events. */
export class RemoteSessions {
  /** `dir`: the account's config folder; none for the viewer's own. */
  constructor(private readonly dir?: string) {}

  /** The sessions claude.ai lists, newest write last. */
  async list(): Promise<SessionSummary[]> {
    const sessions = await listSessions(this.dir);
    return sessions.map(remoteSummary).sort((a, b) => (a.modified ?? "").localeCompare(b.modified ?? ""));
  }

  /** `base` with the prompts, plans, files and agents its events hold, read through the parser a transcript takes. */
  async detail(base: SessionSummary): Promise<SessionSummary> {
    const { events, truncated } = await listEvents(base.id, this.dir);
    const { lines, unknown } = toTranscript(events);
    const read = new SessionReader(base.path).push(lines.length ? lines.join("\n") + "\n" : "");
    return {
      ...read,
      id: base.id,
      path: base.path,
      title: base.title ?? read.title,
      start: base.start ?? read.start,
      end: base.end ?? read.end,
      modified: base.modified,
      remote: { ...base.remote, loaded: true, truncated, unknown: Object.keys(unknown).length ? unknown : undefined },
    };
  }
}
