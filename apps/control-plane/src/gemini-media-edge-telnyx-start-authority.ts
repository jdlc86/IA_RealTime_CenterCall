import type { GeminiMediaEdgeSessionBinding } from "./gemini-media-edge-session-contract.js";

export type GeminiMediaEdgeVerifiedTelnyxStart = Readonly<{
  streamId: string;
  callControlId: string;
  callSessionId: string | null;
  encoding: "L16";
  sampleRate: 16000;
  channels: 1;
}>;

type TelnyxStartMessage = {
  event?: unknown;
  stream_id?: unknown;
  start?: {
    call_control_id?: unknown;
    call_session_id?: unknown;
    media_format?: {
      encoding?: unknown;
      sample_rate?: unknown;
      channels?: unknown;
    };
  };
};

function parseMessage(data: unknown): TelnyxStartMessage {
  let value = data;
  if (typeof data === "string") {
    try { value = JSON.parse(data); } catch { throw new Error("Invalid Telnyx media start JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Telnyx media start message");
  }
  return value as TelnyxStartMessage;
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

/**
 * Receiver-side identity authority for the future Gemini media edge.
 *
 * Authentication of the WebSocket upgrade/token is intentionally owned by the
 * hosting-specific credential verifier. Once that verifier resolves an authorized
 * session binding, this pure function proves that Telnyx's first `start` frame is
 * for the exact call that was admitted and that its audio contract is supported.
 */
export function requireGeminiMediaEdgeTelnyxStart(
  binding: GeminiMediaEdgeSessionBinding,
  data: unknown,
): GeminiMediaEdgeVerifiedTelnyxStart {
  if (binding.provider !== "GEMINI") throw new Error("Gemini media edge binding provider must be GEMINI");
  const expectedCallControlId = required(binding.callControlId, "Gemini media edge bound call_control_id");
  const message = parseMessage(data);
  if (message.event !== "start") throw new Error("Gemini media edge requires Telnyx start as the identity frame");

  const streamId = required(message.stream_id, "Telnyx media stream_id");
  const actualCallControlId = required(message.start?.call_control_id, "Telnyx media start call_control_id");
  if (actualCallControlId !== expectedCallControlId) {
    throw new Error("Telnyx media start call_control_id does not match the authorized Gemini edge session");
  }

  const format = message.start?.media_format;
  if (format?.encoding !== "L16" || format.sample_rate !== 16000 || format.channels !== 1) {
    throw new Error("Telnyx Gemini media requires mono L16 at 16000 Hz");
  }

  const callSessionId = typeof message.start?.call_session_id === "string" && message.start.call_session_id.trim()
    ? message.start.call_session_id.trim()
    : null;

  return Object.freeze({
    streamId,
    callControlId: actualCallControlId,
    callSessionId,
    encoding: "L16" as const,
    sampleRate: 16000 as const,
    channels: 1 as const,
  });
}
