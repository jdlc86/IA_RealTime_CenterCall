import type { GeminiControlEnvelopeV1, GeminiControlTypeV1 } from "./v1";

export type GeminiControlDirectionV1 = "EDGE_TO_WORKER" | "WORKER_TO_EDGE";

const BIDIRECTIONAL = new Set<GeminiControlTypeV1>(["ACK", "NACK", "SYNC"]);

export const EDGE_TO_WORKER_TYPES_V1 = new Set<GeminiControlTypeV1>([
  ...BIDIRECTIONAL,
  "EDGE_READY",
  "MEDIA_STARTED",
  "CALLER_ACTIVITY_STARTED",
  "CALLER_ACTIVITY_ENDED",
  "CALLER_TRANSCRIPT_READY",
  "GEMINI_TOOL_CALL",
  "GEMINI_GENERATION_STARTED",
  "GEMINI_INTERRUPTED",
  "GEMINI_GENERATION_COMPLETE",
  "GEMINI_TURN_COMPLETE",
  "PLAYBACK_STARTED",
  "PLAYBACK_COMPLETED",
  "SESSION_RESUMPTION_UPDATE",
  "PROVIDER_GO_AWAY",
  "PROVIDER_RECONNECTED",
  "MEDIA_CLOSED",
  "EDGE_ERROR",
]);

export const WORKER_TO_EDGE_TYPES_V1 = new Set<GeminiControlTypeV1>([
  ...BIDIRECTIONAL,
  "TURN_AUTHORIZED",
  "TURN_REJECTED",
  "TOOL_RESULT",
  "TOOL_REJECTED",
  "CLEAR_PLAYBACK",
  "SET_PROTECTED_INPUT",
  "START_CONTROL_TURN",
  "TERMINATE_MEDIA",
]);

export function isAllowedDirectionV1(
  type: GeminiControlTypeV1,
  direction: GeminiControlDirectionV1,
): boolean {
  return (direction === "EDGE_TO_WORKER" ? EDGE_TO_WORKER_TYPES_V1 : WORKER_TO_EDGE_TYPES_V1).has(type);
}

export function assertEnvelopeDirectionV1(
  envelope: GeminiControlEnvelopeV1,
  direction: GeminiControlDirectionV1,
): GeminiControlEnvelopeV1 {
  if (!isAllowedDirectionV1(envelope.type, direction)) {
    throw new Error(`Gemini control ${envelope.type} is invalid for ${direction}`);
  }
  return envelope;
}
