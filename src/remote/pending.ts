import type { RemoteEvent } from "./api.js";

/** What a remote session waits for: a tool to be allowed, or Claude's question to be answered (both `can_use_tool`). */
export interface PendingRequest {
  requestId: string;
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown>;
  /** The suggestions Claude Code makes for "always allow" (`permission_suggestions`), sent back as they are. */
  suggestions: unknown[];
  /** The tool's name as the app shows it (`display_name`). */
  displayName?: string;
  description?: string;
  /** The answer needs the session opened (no one-tap allow), as the app tells. */
  needsInteraction: boolean;
  sequence: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The requests of the worker still waiting for an answer, oldest first: a `control_request` of subtype
 * `can_use_tool` from the worker with no `control_response` naming its id after it (from any client) and no
 * `control_cancel_request` for it (the worker sends one when another client answered first).
 */
export function pendingRequests(events: RemoteEvent[]): PendingRequest[] {
  const open = new Map<string, PendingRequest>();
  for (const event of events) {
    const p = event.payload;
    if (p.type === "control_request" && isObject(p.request) && p.request.subtype === "can_use_tool" && typeof p.request_id === "string") {
      // A client asks nothing of the worker this way; only the worker's requests wait for us.
      if (event.source === "client") continue;
      const r = p.request;
      open.set(p.request_id, {
        requestId: p.request_id,
        toolName: typeof r.tool_name === "string" ? r.tool_name : "?",
        toolUseId: typeof r.tool_use_id === "string" ? r.tool_use_id : undefined,
        input: isObject(r.input) ? r.input : {},
        suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
        displayName: typeof r.display_name === "string" && r.display_name ? r.display_name : undefined,
        description: typeof r.description === "string" && r.description ? r.description : undefined,
        needsInteraction: r.requires_user_interaction === true,
        sequence: event.sequence,
      });
    } else if (p.type === "control_response" && isObject(p.response) && typeof p.response.request_id === "string") {
      open.delete(p.response.request_id);
    } else if (p.type === "control_cancel_request" && typeof p.request_id === "string") {
      open.delete(p.request_id);
    }
  }
  return [...open.values()];
}
