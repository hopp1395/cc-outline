import tls from "node:tls";
import { readLogin, RemoteError, type RemoteLogin } from "./credentials.js";

/**
 * The unofficial interface of claude.ai that lists Remote Control sessions and their events (reverse-engineered,
 * see https://github.com/ThatCrispyToast/claude-rc-api). Anthropic does not document it and may change it at any
 * time, so everything read here is checked and a surprise becomes a `format` error. Only GET is ever used.
 */
const BASE = "https://api.anthropic.com";

/** The calls out, swapped by tests. */
export const remote = { fetch: (input: string, init: RequestInit): Promise<Response> => globalThis.fetch(input, init) };

/** A session as the API lists it; fields the API did not send are missing. */
export interface RemoteSession {
  id: string;
  title?: string;
  status?: string;
  /** `idle`, `running` or `requires_action`. */
  workerStatus?: string;
  connectionStatus?: string;
  /** `bridge` for a Remote Control session. */
  environmentKind?: string;
  createdAt?: string;
  lastEventAt?: string;
  userMessageCount?: number;
  /** Ids named anywhere in the session's data (`external_metadata`, `config`, …): a local session's id may be among them. */
  refs: string[];
}

/** One event of a session: its place in the stream and the SDK message it carries. */
export interface RemoteEvent {
  sequence: number;
  createdAt?: string;
  payload: Record<string, unknown>;
}

const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A listed session, or undefined for an entry without an id. */
export function parseSession(raw: unknown): RemoteSession | undefined {
  if (!isObject(raw)) return undefined;
  const id = text(raw.id);
  if (!id) return undefined;
  const refs = [...new Set(JSON.stringify(raw).match(UUID) ?? [])];
  return {
    id,
    title: text(raw.title),
    status: text(raw.status),
    workerStatus: text(raw.worker_status),
    connectionStatus: text(raw.connection_status),
    environmentKind: text(raw.environment_kind),
    createdAt: text(raw.created_at),
    lastEventAt: text(raw.last_event_at),
    userMessageCount: typeof raw.user_message_count === "number" ? raw.user_message_count : undefined,
    refs,
  };
}

let caReady = false;
/** Trusts the system's certificates besides the bundled ones, as a company proxy needs; where Node cannot, the TLS error says what to do. */
function trustSystemCertificates(): void {
  if (caReady) return;
  caReady = true;
  const api = tls as unknown as { getCACertificates?: (type: string) => string[]; setDefaultCACertificates?: (certs: string[]) => void };
  try {
    if (api.getCACertificates && api.setDefaultCACertificates) api.setDefaultCACertificates([...api.getCACertificates("default"), ...api.getCACertificates("system")]);
  } catch {
    // Without it, the first request fails with a hint.
  }
}

const TLS_CODES = new Set(["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED"]);

function networkError(err: unknown): RemoteError {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code && TLS_CODES.has(code)) return new RemoteError("tls", "the connection's certificate is not trusted: start cco with NODE_OPTIONS=--use-system-ca");
  return new RemoteError("offline", "claude.ai cannot be reached");
}

async function get(path: string, login: RemoteLogin): Promise<unknown> {
  trustSystemCertificates();
  let response: Response;
  try {
    response = await remote.fetch(BASE + path, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${login.token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-client-platform": "web_claude_ai",
        "x-organization-uuid": login.org,
        "anthropic-beta": "ccr-byoc-2025-07-29",
      },
    });
  } catch (err) {
    throw networkError(err);
  }
  if (response.status === 401) throw new RemoteError("unauthorized", "claude.ai refused the login: run /login");
  if (response.status === 403) throw new RemoteError("forbidden", "claude.ai refused access (Remote Control may be off for the organisation)");
  if (response.status === 429) throw new RemoteError("rate-limit", "claude.ai asks to slow down");
  if (response.status >= 500) throw new RemoteError("server", `claude.ai answered ${response.status}`);
  if (!response.ok) {
    // The error body says what was wrong with the request.
    const detail = await response.json().then((b: { error?: { message?: unknown } }) => (typeof b?.error?.message === "string" ? `: ${b.error.message.slice(0, 120)}` : ""), () => "");
    throw new RemoteError("format", `claude.ai answered ${response.status}${detail}`);
  }
  try {
    return await response.json();
  } catch {
    throw new RemoteError("format", "claude.ai sent no JSON");
  }
}

/** The sessions of the account of config folder `dir`, as claude.ai lists them. */
export async function listSessions(dir?: string): Promise<RemoteSession[]> {
  const body = await get("/v1/code/sessions", readLogin(dir));
  const data = isObject(body) ? body.data : undefined;
  if (!Array.isArray(data)) throw new RemoteError("format", "the list of sessions is not in the expected shape");
  return data.map(parseSession).filter((s): s is RemoteSession => s !== undefined);
}

/** How many events one request asks for; a session with more is cut at its oldest end and flagged. */
export const EVENT_LIMIT = 100;

/** The newest events of a session, oldest first, and whether older ones were left out. */
export async function listEvents(id: string, dir?: string): Promise<{ events: RemoteEvent[]; truncated: boolean }> {
  const body = await get(`/v1/code/sessions/${encodeURIComponent(id)}/events?limit=${EVENT_LIMIT}&sort_order=desc`, readLogin(dir));
  const data = isObject(body) ? body.data : undefined;
  if (!Array.isArray(data)) throw new RemoteError("format", "the events are not in the expected shape");
  const events: RemoteEvent[] = [];
  for (const raw of data) {
    if (!isObject(raw) || !isObject(raw.payload)) continue;
    const sequence = Number(raw.sequence_num);
    if (!Number.isFinite(sequence)) continue;
    events.push({ sequence, createdAt: text(raw.created_at), payload: raw.payload });
  }
  // The API sends the newest first; the transcript is read oldest first, each event once.
  const unique = [...new Map(events.map((e) => [e.sequence, e])).values()].sort((a, b) => a.sequence - b.sequence);
  return { events: unique, truncated: data.length >= EVENT_LIMIT };
}
