import type { RemoteEvent } from "./api.js";

/** Transcript lines for the events of a remote session, and the kinds of event that have none (counted by `payload.type`). */
export interface Translated {
  lines: string[];
  unknown: Record<string, number>;
}

/**
 * Turns the events of a remote session (SDK messages: `user`, `assistant`, `system`, `result`, …) into the
 * lines of a Claude Code transcript, so the parser and every renderer read them like a local session. The events
 * carry no `uuid` of their own as far as is known, so the sequence number stands in for it (`remote-<n>`), which
 * also keeps a prompt that arrives twice apart from a repeated one. A `result` becomes the `turn_duration` that
 * ends a turn; streaming parts and progress have no counterpart and are only counted.
 */
export function toTranscript(events: RemoteEvent[]): Translated {
  const lines: string[] = [];
  const unknown: Record<string, number> = {};
  for (const event of events) {
    const { payload } = event;
    const type = typeof payload.type === "string" ? payload.type : "?";
    const base = {
      uuid: typeof payload.uuid === "string" ? payload.uuid : `remote-${event.sequence}`,
      timestamp: typeof payload.timestamp === "string" ? payload.timestamp : event.createdAt,
      isSidechain: false,
    };
    if (type === "user" || type === "assistant") {
      lines.push(JSON.stringify({ ...payload, ...withAttachmentLabel(payload), ...base }));
    } else if (type === "system" && payload.subtype === "compact_boundary") {
      lines.push(JSON.stringify({ ...payload, ...base }));
    } else if (type === "system" && payload.subtype === "init") {
      continue;
    } else if (type === "result") {
      const duration = typeof payload.duration_ms === "number" ? payload.duration_ms : undefined;
      lines.push(JSON.stringify({ type: "system", subtype: "turn_duration", ...(duration !== undefined && { durationMs: duration }), ...base }));
    } else {
      unknown[type] = (unknown[type] ?? 0) + 1;
    }
  }
  return { lines, unknown };
}

/** A prompt of attachments only has an empty text, which would start no turn: it gets a label like a local prompt of images. */
function withAttachmentLabel(payload: Record<string, unknown>): Record<string, unknown> {
  const message = payload.message as { content?: unknown } | undefined;
  const files = payload.file_attachments;
  if (payload.type !== "user" || message?.content !== "" || !Array.isArray(files) || files.length === 0) return {};
  return { message: { ...message, content: files.length === 1 ? "[Attachment]" : `[${files.length} attachments]` } };
}
