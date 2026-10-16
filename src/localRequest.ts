import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeDir, readJson, writeJson } from "./transcript/locate.js";

/**
 * What a session of this machine waits for, as its hooks saw it ask: Claude's question (`PreToolUse` of
 * AskUserQuestion) or a tool's permission (`PermissionRequest`). Claude Code writes neither to the transcript until it
 * is answered, so this is the only place a viewer can read it from. Shown only, never answered: that happens in the
 * session's terminal (or through claude.ai for a session connected there).
 */
export interface LocalRequest {
  sessionId: string;
  /** When the hook wrote it (ms). */
  at: number;
  kind: "question" | "permission";
  toolName: string;
  input: Record<string, unknown>;
}

/** Where a session's request is kept: below its own account's folder, one file per session. */
export const localRequestFile = (sessionId: string) => join(claudeDir(), "cco", "requests", `${sessionId}.json`);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Records what the session asks now, from a hook's input; anything else is left alone. */
export function recordLocalRequest(input: { hook_event_name?: string; session_id?: string; tool_name?: string; tool_input?: unknown }, now = Date.now()): void {
  const { session_id: sessionId, tool_name: toolName, tool_input: toolInput } = input;
  if (!sessionId || !toolName || !isObject(toolInput)) return;
  const kind = input.hook_event_name === "PermissionRequest" ? "permission" : toolName === "AskUserQuestion" ? "question" : undefined;
  if (!kind) return;
  const file = localRequestFile(sessionId);
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, { sessionId, at: now, kind, toolName, input: toolInput } satisfies LocalRequest);
}

/** Forgets the session's request: a prompt was typed, or the session ended. */
export function clearLocalRequest(sessionId: string): void {
  rmSync(localRequestFile(sessionId), { force: true });
}

/**
 * The request the session waits for now, if its hooks recorded one: only while Claude Code says it waits, and only one
 * written after the transcript's last write (once it is answered, Claude Code writes the call and its result).
 */
export function readLocalRequest(sessionId: string, transcript: string | undefined): LocalRequest | undefined {
  const request = readJson<LocalRequest>(localRequestFile(sessionId));
  if (!isObject(request) || typeof request.at !== "number" || typeof request.toolName !== "string" || !isObject(request.input)) return undefined;
  if (request.kind !== "question" && request.kind !== "permission") return undefined;
  let written = 0;
  try {
    if (transcript) written = statSync(transcript).mtimeMs;
  } catch {
    // No transcript yet: nothing was answered after it.
  }
  return request.at >= written ? request : undefined;
}

/** Removes the requests of sessions older than `age` (ms): what a session that ended without its hooks left behind. */
export function removeOldLocalRequests(age = 24 * 60 * 60 * 1000, now = Date.now()): void {
  const dir = join(claudeDir(), "cco", "requests");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > age) rmSync(file, { force: true });
    } catch {
      // Gone already.
    }
  }
}

/** The lines that tell what the request is: the questions with their options, or the tool and what it is to do. */
export function localRequestLines(request: LocalRequest, width: number): string[] {
  const cut = (s: string) => (s.length > width ? `${s.slice(0, width - 1)}…` : s);
  if (request.kind === "question" && Array.isArray(request.input.questions)) {
    const lines: string[] = [];
    for (const q of request.input.questions) {
      if (!isObject(q)) continue;
      if (typeof q.question === "string") lines.push(cut(q.question));
      if (Array.isArray(q.options)) for (const o of q.options) if (isObject(o) && typeof o.label === "string") lines.push(cut(`  · ${o.label}`));
    }
    return lines;
  }
  const { input } = request;
  if (typeof input.command === "string") return input.command.split("\n").slice(0, 6).map((l, i) => cut(`${i === 0 ? "$ " : "  "}${l}`));
  const lines: string[] = [];
  if (typeof input.file_path === "string") lines.push(cut(input.file_path));
  for (const [key, v] of Object.entries(input)) {
    if (key === "file_path" || lines.length >= 6) continue;
    lines.push(cut(`${key}: ${(typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ")}`));
  }
  return lines;
}

/** The request in one line: the first question, or the tool and its command or file. */
export function localRequestSummary(request: LocalRequest, width: number): string {
  if (request.kind === "question") return localRequestLines(request, width)[0] ?? "Claude asks a question";
  const first = localRequestLines(request, width - request.toolName.length - 8)[0];
  return `allow ${request.toolName}${first ? `: ${first}` : "?"}`;
}
