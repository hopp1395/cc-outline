import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import tls from "node:tls";
import { PROFILE_SCOPE, readLogin, readToken, RemoteError, type RemoteLogin } from "./credentials.js";
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
  if (code && TLS_CODES.has(code)) return new RemoteError("tls", "the connection's certificate is not trusted: start cco with NODE_OPTIONS=--use-system-ca");
  return new RemoteError("offline", "claude.ai cannot be reached");
}

/** What a 403 says: the sessions' calls are refused where Remote Control is off for the organisation. */
const SESSIONS_FORBIDDEN = "claude.ai refused access (Remote Control may be off for the organisation)";

/** The headers of the sessions' calls, as the web and the app send them. */
const sessionHeaders = (login: RemoteLogin): Record<string, string> => ({
  Authorization: `Bearer ${login.token}`,
  "anthropic-version": "2023-06-01",
  // As the web and the app: another platform makes the worker take a prompt as a peer's message, which starts no turn.
  "anthropic-client-platform": "web_claude_ai",
  "x-organization-uuid": login.org,
  "anthropic-beta": "ccr-byoc-2025-07-29",
});

const get = (path: string, login: RemoteLogin, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<unknown> =>
  request(path, sessionHeaders(login), SESSIONS_FORBIDDEN, body, method);

async function request(path: string, headers: Record<string, string>, forbidden: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<unknown> {
  trustSystemCertificates();
  let response: Response;
  try {
    response = await remote.fetch(BASE + path, {
      method,
      headers: { ...headers, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw networkError(err);
  }
  return answer(response, forbidden, body !== undefined);
}

/** What claude.ai answered: its JSON, or the error its status says (`forbidden` for a 403); a write (`wrote`) needs no JSON. */
async function answer(response: Response, forbidden: string, wrote = false): Promise<unknown> {
  if (response.status === 401) throw new RemoteError("unauthorized", "claude.ai refused the login: run /login");
  if (response.status === 403) throw new RemoteError("forbidden", forbidden);
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
    // A write needs no answer: what it did shows in the events.
    if (wrote) return undefined;
    throw new RemoteError("format", "claude.ai sent no JSON");
  }
}

/**
 * The plan's usage of the account of config folder `dir`, as Claude Code's `/usage` asks for it: `GET /api/oauth/usage`
 * with the login's token (scope `user:profile`), unchecked (`parseUsage` in `quota.ts` checks it).
 */
export function getUsage(dir?: string): Promise<unknown> {
  const token = readToken(dir, Date.now(), PROFILE_SCOPE);
  return request("/api/oauth/usage", { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, "claude.ai refused to tell the usage of this login");
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

/** A file uploaded to claude.ai (`uploadFile`), for a prompt's `file_attachments`. */
export interface RemoteFile {
  fileUuid: string;
  fileName: string;
  isImage: boolean;
  size: number;
}

/** The platform a prompt names in its payload: the web app's, one a person types in. */
const CLIENT_PLATFORM = "web_claude_ai";

/**
 * Sends `text` as a prompt to session `id`; mid-turn, Claude Code queues it like a prompt typed while it works. `files`
 * (uploaded with `uploadFile`) go along as the prompt's `file_attachments`, as the app sends what is attached: the
 * Claude Code that runs the session downloads them and tells Claude where they are. The payload names
 * `client_platform` itself: claude.ai stopped filling it in from the header (November 2026), and a worker (2.1.329)
 * demotes a prompt without one to a peer's message, so a `/` command arrived as text.
 */
export async function sendPrompt(id: string, text: string, dir?: string, files: RemoteFile[] = []): Promise<void> {
  const attachments = files.map((f) => ({ file_uuid: f.fileUuid, file_name: f.fileName, is_image: f.isImage, file_size: f.size }));
  await postEvents(id, [{ type: "user", uuid: randomUUID(), client_platform: CLIENT_PLATFORM, message: { role: "user", content: text }, ...(attachments.length > 0 && { file_attachments: attachments }) }], dir);
}

/** The scope Claude Code's login needs to upload files. */
export const UPLOAD_SCOPE = "user:file_upload";

/** The media types of the files `uploadFile` takes, by extension. */
const MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };

/**
 * Uploads `data` as the file `name` to claude.ai, the way Claude Code sends its files to the app (`POST
 * /api/oauth/file_upload`, multipart with the field `file`, the login's token with `UPLOAD_SCOPE`; it answers 201
 * with `file_uuid`). The file is the account's; a prompt names it by its id (`sendPrompt`'s `files`).
 */
export async function uploadFile(data: Uint8Array, name: string, dir?: string): Promise<RemoteFile> {
  const token = readToken(dir, Date.now(), UPLOAD_SCOPE);
  const mediaType = MEDIA_TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(data)], { type: mediaType }), name);
  trustSystemCertificates();
  let response: Response;
  try {
    response = await remote.fetch(`${BASE}/api/oauth/file_upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  } catch (err) {
    throw networkError(err);
  }
  if (response.status === 413) throw new RemoteError("format", `claude.ai refused ${name}: too large`);
  const body = await answer(response, "claude.ai refused the upload");
  const uuid = isObject(body) ? text(body.file_uuid) : undefined;
  if (!uuid) throw new RemoteError("format", "the upload's answer is not in the expected shape");
  return { fileUuid: uuid, fileName: name, isImage: mediaType.startsWith("image/"), size: data.length };
}

/** Uploads the files at `paths` one after the other (`uploadFile`); a file that cannot be read stops it, named. */
export async function uploadFiles(paths: string[], dir?: string): Promise<RemoteFile[]> {
  const files: RemoteFile[] = [];
  for (const path of paths) {
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch {
      throw new RemoteError("format", `${basename(path)} cannot be read`);
    }
    files.push(await uploadFile(data, basename(path), dir));
  }
  return files;
}

/**
 * Asks session `id` what it offers, as the app does when it opens one: the worker answers with a `control_response`
 * (its `commands` are empty for a Remote Control session, 2.1.310) and then writes a whole `system` `init` event,
 * whose `slash_commands` the app lists.
 */
export async function sendInitialize(id: string, dir?: string): Promise<void> {
  await postEvents(id, [{ type: "control_request", request_id: randomUUID(), request: { subtype: "initialize" } }], dir);
}

/** Stops what Claude does in session `id`, as Esc in the terminal or the stop button of the app. */
export async function sendInterrupt(id: string, dir?: string): Promise<void> {
  await postEvents(id, [{ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }], dir);
}

/**
 * Gives session `id` the title `title` on claude.ai, as Claude Code does after a /rename (`PUT`, 2.1.314). The Claude
 * Code that runs it keeps its own name: `sendRename` tells it.
 */
export async function setTitle(id: string, title: string, dir?: string): Promise<void> {
  await get(`/v1/code/sessions/${encodeURIComponent(id)}`, readLogin(dir), { title }, "PUT");
}

/**
 * Tells the Claude Code that runs session `id` its new name, as the app does after renaming it: it takes it as if
 * /rename were typed there (its transcript's `custom-title`, its name in `~/.claude/sessions`) and answers with a
 * `control_response`. Returns the request's id, which `confirmed` looks for.
 */
export async function sendRename(id: string, title: string, dir?: string): Promise<string> {
  const requestId = randomUUID();
  await postEvents(id, [{ type: "control_request", request_id: requestId, request: { subtype: "rename_session", title } }], dir);
  return requestId;
}

/** Whether the worker of session `id` answered the request `requestId` with success, among the newest events. */
export async function confirmed(id: string, requestId: string, dir?: string): Promise<boolean> {
  const { events } = await listEvents(id, dir);
  return events.some(({ payload }) => {
    const response = payload.type === "control_response" && isObject(payload.response) ? payload.response : undefined;
    return response?.request_id === requestId && response.subtype === "success";
  });
}

/**
 * Answers the worker's request `requestId` in session `id` (a tool to allow, a question), as the app does: a
 * `control_response` whose `response` the worker hands Claude Code (`behavior`, `updatedInput`, …).
 */
export async function sendResponse(id: string, requestId: string, response: Record<string, unknown>, dir?: string): Promise<void> {
  await postEvents(id, [{ type: "control_response", uuid: randomUUID(), response: { subtype: "success", request_id: requestId, response } }], dir);
}
