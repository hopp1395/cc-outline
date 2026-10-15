import { randomUUID } from "node:crypto";
import tls from "node:tls";
import { L } from "../i18n/index.js";
import { readLogin, RemoteError, type RemoteLogin } from "./credentials.js";
import type { PendingRequest } from "./pending.js";

/**
 * The unofficial interface of claude.ai that lists Remote Control sessions and their events (reverse-engineered,
 * see https://github.com/ThatCrispyToast/claude-rc-api). Anthropic does not document it and may change it at any
 * time, so everything read here is checked and a surprise becomes a `format` error. Reading is GET; with the
 * remoteControl setting, `sendPrompt` and `sendInterrupt` POST events the way the Claude app does.
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
  /** What the worker waits for while `requires_action` (`external_metadata.pending_action`), so the list can answer it. */
  pending?: PendingRequest;
}

/** One event of a session: its place in the stream and the SDK message it carries. */
export interface RemoteEvent {
  sequence: number;
  createdAt?: string;
  /** Who wrote it: `worker` (the Claude Code running the session) or `client` (the app, claude.ai, cco). */
  source?: string;
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
    pending: text(raw.worker_status) === "requires_action" && isObject(raw.external_metadata) ? pendingAction(raw.external_metadata.pending_action) : undefined,
  };
}

/**
 * The request a listed session waits for. Its id was in `suppressed_request_id` (with `request_id` empty) when the
 * app was connected; either one names the worker's `control_request`.
 */
function pendingAction(raw: unknown): PendingRequest | undefined {
  if (!isObject(raw)) return undefined;
  const requestId = text(raw.request_id) ?? text(raw.suppressed_request_id);
  const toolName = text(raw.tool_name);
  if (!requestId || !toolName) return undefined;
  return {
    requestId,
    toolName,
    toolUseId: text(raw.tool_use_id),
    input: isObject(raw.input) ? raw.input : {},
    suggestions: Array.isArray(raw.permission_suggestions) ? raw.permission_suggestions : [],
    displayName: text(raw.display_tool_name),
    description: text(raw.action_description),
    needsInteraction: true,
    sequence: -1,
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
  if (code && TLS_CODES.has(code)) return new RemoteError("tls", L().remote.tls);
  return new RemoteError("offline", L().remote.offline);
}

async function get(path: string, login: RemoteLogin, body?: unknown): Promise<unknown> {
  trustSystemCertificates();
  let response: Response;
  try {
    response = await remote.fetch(BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${login.token}`,
        "anthropic-version": "2023-06-01",
        // As the web and the app: another platform makes the worker take a prompt as a peer's message, which starts no turn.
        "anthropic-client-platform": "web_claude_ai",
        "x-organization-uuid": login.org,
        "anthropic-beta": "ccr-byoc-2025-07-29",
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw networkError(err);
  }
  if (response.status === 401) throw new RemoteError("unauthorized", L().remote.unauthorized);
  if (response.status === 403) throw new RemoteError("forbidden", L().remote.forbidden);
  if (response.status === 429) throw new RemoteError("rate-limit", L().remote.rateLimit);
  if (response.status >= 500) throw new RemoteError("server", L().remote.answered(String(response.status)));
  if (!response.ok) {
    // The error body says what was wrong with the request.
    const detail = await response.json().then((b: { error?: { message?: unknown } }) => (typeof b?.error?.message === "string" ? `: ${b.error.message.slice(0, 120)}` : ""), () => "");
    throw new RemoteError("format", L().remote.answered(`${response.status}${detail}`));
  }
  try {
    return await response.json();
  } catch {
    // A write needs no answer: what it did shows in the events.
    if (body !== undefined) return undefined;
    throw new RemoteError("format", L().remote.noJson);
  }
}

/**
 * How many sessions one list asks for, the newest first: without it claude.ai sends 20, archived ones among them, and
 * a session the app still lists (not archived) can be older than those.
 */
export const SESSION_LIMIT = 100;

/** The sessions of the account of config folder `dir`, as claude.ai lists them, archived ones too. */
export async function listSessions(dir?: string): Promise<RemoteSession[]> {
  const body = await get(`/v1/code/sessions?limit=${SESSION_LIMIT}`, readLogin(dir));
  const data = isObject(body) ? body.data : undefined;
  if (!Array.isArray(data)) throw new RemoteError("format", L().remote.listShape);
  return data.map(parseSession).filter((s): s is RemoteSession => s !== undefined);
}

/** How many events one request asks for; a session with more is cut at its oldest end and flagged. */
export const EVENT_LIMIT = 100;

/** The newest events of a session, oldest first, and whether older ones were left out. */
export async function listEvents(id: string, dir?: string): Promise<{ events: RemoteEvent[]; truncated: boolean }> {
  const body = await get(`/v1/code/sessions/${encodeURIComponent(id)}/events?limit=${EVENT_LIMIT}&sort_order=desc`, readLogin(dir));
  const data = isObject(body) ? body.data : undefined;
  if (!Array.isArray(data)) throw new RemoteError("format", L().remote.eventsShape);
  const events: RemoteEvent[] = [];
  for (const raw of data) {
    if (!isObject(raw) || !isObject(raw.payload)) continue;
    const sequence = Number(raw.sequence_num);
    if (!Number.isFinite(sequence)) continue;
    events.push({ sequence, createdAt: text(raw.created_at), source: text(raw.source), payload: raw.payload });
  }
  // The API sends the newest first; the transcript is read oldest first, each event once.
  const unique = [...new Map(events.map((e) => [e.sequence, e])).values()].sort((a, b) => a.sequence - b.sequence);
  return { events: unique, truncated: data.length >= EVENT_LIMIT };
}

/** Writes `payloads` into session `id` as the client's events, the way the Claude app sends them. */
async function postEvents(id: string, payloads: Record<string, unknown>[], dir?: string): Promise<void> {
  await get(`/v1/code/sessions/${encodeURIComponent(id)}/events`, readLogin(dir), { events: payloads.map((payload) => ({ payload })) });
}

/** Sends `text` as a prompt to session `id`; mid-turn, Claude Code queues it like a prompt typed while it works. */
export async function sendPrompt(id: string, text: string, dir?: string): Promise<void> {
  await postEvents(id, [{ type: "user", uuid: randomUUID(), message: { role: "user", content: text } }], dir);
}

/** Stops what Claude does in session `id`, as Esc in the terminal or the stop button of the app. */
export async function sendInterrupt(id: string, dir?: string): Promise<void> {
  await postEvents(id, [{ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }], dir);
}

/**
 * Answers the worker's request `requestId` in session `id` (a tool to allow, a question), as the app does: a
 * `control_response` whose `response` the worker hands Claude Code (`behavior`, `updatedInput`, …).
 */
export async function sendResponse(id: string, requestId: string, response: Record<string, unknown>, dir?: string): Promise<void> {
  await postEvents(id, [{ type: "control_response", uuid: randomUUID(), response: { subtype: "success", request_id: requestId, response } }], dir);
}
