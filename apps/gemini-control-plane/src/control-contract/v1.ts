export const GEMINI_CONTROL_PROTOCOL_V1 = "gemini-control.v1" as const;

export const MAX_ENVELOPE_BYTES_V1 = 64 * 1024;
export const MAX_ID_CHARS_V1 = 160;
export const MAX_TRANSCRIPT_CHARS_V1 = 3_000;
export const MAX_TOOL_JSON_BYTES_V1 = 32 * 1024;

export const GEMINI_CONTROL_TYPES_V1 = [
  "ACK",
  "NACK",
  "SYNC",
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
  "TURN_AUTHORIZED",
  "TURN_REJECTED",
  "TOOL_RESULT",
  "TOOL_REJECTED",
  "CLEAR_PLAYBACK",
  "SET_PROTECTED_INPUT",
  "START_CONTROL_TURN",
  "TERMINATE_MEDIA",
] as const;

export type GeminiControlTypeV1 = typeof GEMINI_CONTROL_TYPES_V1[number];

export type GeminiControlEnvelopeV1 = Readonly<{
  protocol: typeof GEMINI_CONTROL_PROTOCOL_V1;
  call_session_id: string;
  message_id: string;
  sequence: number;
  type: GeminiControlTypeV1;
  ack_required: boolean;
  payload: Readonly<Record<string, unknown>>;
}>;

export type InboundSequenceStateV1 = Readonly<{
  lastAppliedSequence: number;
  appliedMessageIds: ReadonlySet<string>;
}>;

export type InboundSequenceDecisionV1 =
  | Readonly<{ action: "APPLY"; nextLastAppliedSequence: number }>
  | Readonly<{ action: "DUPLICATE"; nextLastAppliedSequence: number }>
  | Readonly<{ action: "OUT_OF_ORDER"; expectedSequence: number; receivedSequence: number }>;

export type AckResultV1 = "APPLIED" | "DUPLICATE_ALREADY_APPLIED" | "ACCEPTED_NO_EFFECT";

export type NackCodeV1 =
  | "INVALID_ENVELOPE"
  | "UNSUPPORTED_CONTRACT_VERSION"
  | "SESSION_BINDING_MISMATCH"
  | "OUT_OF_ORDER_SEQUENCE"
  | "REPLAY_WINDOW_EXCEEDED"
  | "INVALID_STATE"
  | "IDENTITY_MISMATCH"
  | "INVALID_PAYLOAD"
  | "COMMAND_REJECTED"
  | "PROTOCOL_VIOLATION"
  | "SESSION_TERMINAL";

const controlTypes = new Set<string>(GEMINI_CONTROL_TYPES_V1);
const acklessTypes = new Set<GeminiControlTypeV1>(["ACK", "NACK"]);

function fail(message: string): never {
  throw new Error(message);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, field: string, maxChars = MAX_ID_CHARS_V1): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > maxChars || /[\r\n\t]/.test(normalized)) fail(`${field} is invalid`);
  return normalized;
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`${field} must be a positive safe integer`);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field} must be boolean`);
  return value;
}

function jsonBytes(value: unknown): number {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail("value is not JSON serializable");
  }
  if (encoded === undefined) fail("value is not JSON serializable");
  return new TextEncoder().encode(encoded).byteLength;
}

function optionalString(value: unknown, field: string, maxChars = MAX_ID_CHARS_V1): string | null {
  if (value === undefined || value === null) return null;
  return boundedString(value, field, maxChars);
}

function requireCommandId(payload: Record<string, unknown>): string {
  return boundedString(payload.command_id, "payload.command_id");
}

function requireTurnId(payload: Record<string, unknown>): string {
  return boundedString(payload.turn_id, "payload.turn_id");
}

function requireGenerationId(payload: Record<string, unknown>): string {
  return boundedString(payload.generation_id, "payload.generation_id");
}

function requireToolIdentity(payload: Record<string, unknown>): void {
  boundedString(payload.tool_call_id, "payload.tool_call_id");
  boundedString(payload.tool_name, "payload.tool_name", 128);
}

export function validatePayloadV1(type: GeminiControlTypeV1, payloadValue: unknown): Readonly<Record<string, unknown>> {
  const payload = asRecord(payloadValue, "payload");

  switch (type) {
    case "ACK": {
      boundedString(payload.acked_message_id, "payload.acked_message_id");
      positiveSafeInteger(payload.acked_sequence, "payload.acked_sequence");
      if (!["APPLIED", "DUPLICATE_ALREADY_APPLIED", "ACCEPTED_NO_EFFECT"].includes(String(payload.result))) {
        fail("payload.result is invalid");
      }
      break;
    }
    case "NACK": {
      boundedString(payload.rejected_message_id, "payload.rejected_message_id");
      positiveSafeInteger(payload.rejected_sequence, "payload.rejected_sequence");
      boundedString(payload.code, "payload.code", 96);
      boolean(payload.retryable, "payload.retryable");
      boolean(payload.terminal, "payload.terminal");
      break;
    }
    case "SYNC": {
      if (typeof payload.last_remote_sequence_applied !== "number" || !Number.isSafeInteger(payload.last_remote_sequence_applied) || payload.last_remote_sequence_applied < 0) {
        fail("payload.last_remote_sequence_applied is invalid");
      }
      if (typeof payload.last_local_sequence_emitted !== "number" || !Number.isSafeInteger(payload.last_local_sequence_emitted) || payload.last_local_sequence_emitted < 0) {
        fail("payload.last_local_sequence_emitted is invalid");
      }
      boundedString(payload.edge_session_id, "payload.edge_session_id");
      break;
    }
    case "EDGE_READY":
      boundedString(payload.edge_session_id, "payload.edge_session_id");
      positiveSafeInteger(payload.provider_connection_epoch, "payload.provider_connection_epoch");
      break;
    case "MEDIA_STARTED":
      boundedString(payload.stream_id, "payload.stream_id");
      break;
    case "CALLER_ACTIVITY_STARTED":
      requireTurnId(payload);
      optionalString(payload.generation_id_at_start, "payload.generation_id_at_start");
      break;
    case "CALLER_ACTIVITY_ENDED":
      requireTurnId(payload);
      break;
    case "CALLER_TRANSCRIPT_READY": {
      requireTurnId(payload);
      boundedString(payload.authority, "payload.authority", 64);
      if (payload.is_final !== true) fail("payload.is_final must be true in v1");
      const transcript = boundedString(payload.transcript, "payload.transcript", MAX_TRANSCRIPT_CHARS_V1);
      if (!transcript) fail("payload.transcript is required");
      break;
    }
    case "GEMINI_TOOL_CALL":
      requireTurnId(payload);
      requireToolIdentity(payload);
      if (!("arguments" in payload)) fail("payload.arguments is required");
      if (jsonBytes(payload.arguments) > MAX_TOOL_JSON_BYTES_V1) fail("payload.arguments exceeds v1 limit");
      break;
    case "GEMINI_GENERATION_STARTED":
      optionalString(payload.turn_id, "payload.turn_id");
      requireGenerationId(payload);
      if (!["CALLER_TURN", "TOOL_CONTINUATION", "CONTROL_TURN"].includes(String(payload.origin))) fail("payload.origin is invalid");
      break;
    case "GEMINI_INTERRUPTED":
    case "GEMINI_GENERATION_COMPLETE":
    case "GEMINI_TURN_COMPLETE":
      requireGenerationId(payload);
      break;
    case "PLAYBACK_STARTED":
    case "PLAYBACK_COMPLETED":
      requireGenerationId(payload);
      boundedString(payload.playback_id, "payload.playback_id");
      break;
    case "SESSION_RESUMPTION_UPDATE":
      positiveSafeInteger(payload.provider_connection_epoch, "payload.provider_connection_epoch");
      boundedString(payload.handle_ref, "payload.handle_ref");
      break;
    case "PROVIDER_GO_AWAY":
      positiveSafeInteger(payload.provider_connection_epoch, "payload.provider_connection_epoch");
      if (typeof payload.time_left_ms !== "number" || !Number.isSafeInteger(payload.time_left_ms) || payload.time_left_ms < 0) fail("payload.time_left_ms is invalid");
      break;
    case "PROVIDER_RECONNECTED":
      positiveSafeInteger(payload.previous_provider_connection_epoch, "payload.previous_provider_connection_epoch");
      positiveSafeInteger(payload.provider_connection_epoch, "payload.provider_connection_epoch");
      if (!["RESUMED", "CLEAN_RESTART"].includes(String(payload.mode))) fail("payload.mode is invalid");
      break;
    case "MEDIA_CLOSED":
      boundedString(payload.reason, "payload.reason", 96);
      break;
    case "EDGE_ERROR":
      boundedString(payload.category, "payload.category", 96);
      boolean(payload.terminal, "payload.terminal");
      break;
    case "TURN_AUTHORIZED":
      requireCommandId(payload);
      requireTurnId(payload);
      break;
    case "TURN_REJECTED":
      requireCommandId(payload);
      requireTurnId(payload);
      boundedString(payload.policy_code, "payload.policy_code", 96);
      boolean(payload.terminal, "payload.terminal");
      break;
    case "TOOL_RESULT":
      requireCommandId(payload);
      requireTurnId(payload);
      requireToolIdentity(payload);
      if (!("result" in payload)) fail("payload.result is required");
      if (jsonBytes(payload.result) > MAX_TOOL_JSON_BYTES_V1) fail("payload.result exceeds v1 limit");
      break;
    case "TOOL_REJECTED":
      requireCommandId(payload);
      requireTurnId(payload);
      requireToolIdentity(payload);
      boundedString(payload.policy_code, "payload.policy_code", 96);
      boolean(payload.terminal, "payload.terminal");
      break;
    case "CLEAR_PLAYBACK":
      requireCommandId(payload);
      requireGenerationId(payload);
      boundedString(payload.reason, "payload.reason", 96);
      break;
    case "SET_PROTECTED_INPUT":
      requireCommandId(payload);
      boolean(payload.enabled, "payload.enabled");
      optionalString(payload.control_turn_id, "payload.control_turn_id");
      break;
    case "START_CONTROL_TURN":
      requireCommandId(payload);
      boundedString(payload.control_turn_id, "payload.control_turn_id");
      if (!["GREETING", "PRESENCE", "RECOVERY", "HANDOFF_ANNOUNCEMENT", "TERMINAL_MESSAGE"].includes(String(payload.control_kind))) {
        fail("payload.control_kind is invalid");
      }
      break;
    case "TERMINATE_MEDIA":
      requireCommandId(payload);
      boundedString(payload.reason, "payload.reason", 96);
      break;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }

  return Object.freeze(structuredClone(payload));
}

export function parseEnvelopeV1(value: unknown, expectedCallSessionId?: string): GeminiControlEnvelopeV1 {
  if (jsonBytes(value) > MAX_ENVELOPE_BYTES_V1) fail("Gemini control envelope exceeds v1 limit");
  const source = asRecord(value, "Gemini control envelope");
  if (source.protocol !== GEMINI_CONTROL_PROTOCOL_V1) fail("Unsupported Gemini control protocol");

  const callSessionId = boundedString(source.call_session_id, "call_session_id");
  if (expectedCallSessionId && callSessionId !== expectedCallSessionId) fail("Gemini control call_session_id binding mismatch");

  const messageId = boundedString(source.message_id, "message_id");
  const sequence = positiveSafeInteger(source.sequence, "sequence");
  const typeValue = boundedString(source.type, "type", 96);
  if (!controlTypes.has(typeValue)) fail("Gemini control type is unsupported");
  const type = typeValue as GeminiControlTypeV1;
  const ackRequired = boolean(source.ack_required, "ack_required");
  if (acklessTypes.has(type) && ackRequired) fail(`${type} must not require ACK`);
  const payload = validatePayloadV1(type, source.payload);

  return Object.freeze({
    protocol: GEMINI_CONTROL_PROTOCOL_V1,
    call_session_id: callSessionId,
    message_id: messageId,
    sequence,
    type,
    ack_required: ackRequired,
    payload,
  });
}

export function applyInboundSequenceV1(
  state: InboundSequenceStateV1,
  envelope: GeminiControlEnvelopeV1,
): InboundSequenceDecisionV1 {
  if (!Number.isSafeInteger(state.lastAppliedSequence) || state.lastAppliedSequence < 0) fail("Invalid inbound sequence state");
  const expected = state.lastAppliedSequence + 1;

  if (envelope.sequence === expected) {
    return Object.freeze({ action: "APPLY", nextLastAppliedSequence: envelope.sequence });
  }

  if (envelope.sequence <= state.lastAppliedSequence && state.appliedMessageIds.has(envelope.message_id)) {
    return Object.freeze({ action: "DUPLICATE", nextLastAppliedSequence: state.lastAppliedSequence });
  }

  return Object.freeze({
    action: "OUT_OF_ORDER",
    expectedSequence: expected,
    receivedSequence: envelope.sequence,
  });
}

export function buildAckV1(input: {
  callSessionId: string;
  messageId: string;
  sequence: number;
  ackedMessageId: string;
  ackedSequence: number;
  result: AckResultV1;
}): GeminiControlEnvelopeV1 {
  return parseEnvelopeV1({
    protocol: GEMINI_CONTROL_PROTOCOL_V1,
    call_session_id: input.callSessionId,
    message_id: input.messageId,
    sequence: input.sequence,
    type: "ACK",
    ack_required: false,
    payload: {
      acked_message_id: input.ackedMessageId,
      acked_sequence: input.ackedSequence,
      result: input.result,
    },
  });
}

export function buildNackV1(input: {
  callSessionId: string;
  messageId: string;
  sequence: number;
  rejectedMessageId: string;
  rejectedSequence: number;
  code: NackCodeV1;
  retryable: boolean;
  terminal: boolean;
}): GeminiControlEnvelopeV1 {
  return parseEnvelopeV1({
    protocol: GEMINI_CONTROL_PROTOCOL_V1,
    call_session_id: input.callSessionId,
    message_id: input.messageId,
    sequence: input.sequence,
    type: "NACK",
    ack_required: false,
    payload: {
      rejected_message_id: input.rejectedMessageId,
      rejected_sequence: input.rejectedSequence,
      code: input.code,
      retryable: input.retryable,
      terminal: input.terminal,
    },
  });
}
