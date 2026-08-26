import { describe, expect, it } from "vitest";
import {
  GEMINI_CONTROL_PROTOCOL_V1,
  MAX_TRANSCRIPT_CHARS_V1,
  applyInboundSequenceV1,
  buildAckV1,
  buildNackV1,
  parseEnvelopeV1,
} from "./v1.js";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    protocol: GEMINI_CONTROL_PROTOCOL_V1,
    call_session_id: "cs_test",
    message_id: "msg_1",
    sequence: 1,
    type: "EDGE_READY",
    ack_required: true,
    payload: {
      edge_session_id: "edge_1",
      provider_connection_epoch: 1,
    },
    ...overrides,
  };
}

describe("gemini-control.v1 envelope", () => {
  it("accepts a valid v1 envelope bound to the expected call session", () => {
    const parsed = parseEnvelopeV1(envelope(), "cs_test");
    expect(parsed.protocol).toBe(GEMINI_CONTROL_PROTOCOL_V1);
    expect(parsed.type).toBe("EDGE_READY");
    expect(parsed.sequence).toBe(1);
  });

  it("fails closed on version mismatch", () => {
    expect(() => parseEnvelopeV1(envelope({ protocol: "gemini-control.v2" }))).toThrow(/Unsupported Gemini control protocol/);
  });

  it("fails closed on call session binding mismatch", () => {
    expect(() => parseEnvelopeV1(envelope(), "cs_other")).toThrow(/binding mismatch/);
  });

  it("requires ACK and NACK themselves to be ackless", () => {
    expect(() => parseEnvelopeV1({
      ...envelope(),
      type: "ACK",
      ack_required: true,
      payload: { acked_message_id: "msg_0", acked_sequence: 1, result: "APPLIED" },
    })).toThrow(/must not require ACK/);
  });

  it("rejects oversized caller transcript", () => {
    expect(() => parseEnvelopeV1({
      ...envelope(),
      type: "CALLER_TRANSCRIPT_READY",
      payload: {
        turn_id: "turn_1",
        transcript: "x".repeat(MAX_TRANSCRIPT_CHARS_V1 + 1),
        authority: "GOOGLE_STT_V2",
        is_final: true,
      },
    })).toThrow(/payload.transcript is invalid/);
  });

  it("requires the real tool identity and bounded arguments", () => {
    const parsed = parseEnvelopeV1({
      ...envelope(),
      type: "GEMINI_TOOL_CALL",
      payload: {
        turn_id: "turn_1",
        tool_call_id: "provider_call_1",
        tool_name: "restaurant_reservation_create",
        arguments: { starts_at: "2026-08-27T13:00:00+02:00" },
      },
    });
    expect(parsed.payload.tool_call_id).toBe("provider_call_1");
  });
});

describe("gemini-control.v1 sequencing", () => {
  it("applies exactly the next sequence", () => {
    const parsed = parseEnvelopeV1(envelope({ sequence: 4 }));
    expect(applyInboundSequenceV1({ lastAppliedSequence: 3, appliedMessageIds: new Set() }, parsed)).toEqual({
      action: "APPLY",
      nextLastAppliedSequence: 4,
    });
  });

  it("classifies an already-applied message id as duplicate without advancing", () => {
    const parsed = parseEnvelopeV1(envelope({ sequence: 3, message_id: "msg_old" }));
    expect(applyInboundSequenceV1({ lastAppliedSequence: 4, appliedMessageIds: new Set(["msg_old"]) }, parsed)).toEqual({
      action: "DUPLICATE",
      nextLastAppliedSequence: 4,
    });
  });

  it("does not accept a reused sequence with a different message identity", () => {
    const parsed = parseEnvelopeV1(envelope({ sequence: 3, message_id: "msg_conflict" }));
    expect(applyInboundSequenceV1({ lastAppliedSequence: 4, appliedMessageIds: new Set(["msg_other"]) }, parsed)).toEqual({
      action: "OUT_OF_ORDER",
      expectedSequence: 5,
      receivedSequence: 3,
    });
  });

  it("does not skip a sequence gap", () => {
    const parsed = parseEnvelopeV1(envelope({ sequence: 6 }));
    expect(applyInboundSequenceV1({ lastAppliedSequence: 4, appliedMessageIds: new Set() }, parsed)).toEqual({
      action: "OUT_OF_ORDER",
      expectedSequence: 5,
      receivedSequence: 6,
    });
  });
});

describe("gemini-control.v1 ACK/NACK", () => {
  it("builds a correlated ACK", () => {
    const ack = buildAckV1({
      callSessionId: "cs_test",
      messageId: "ack_1",
      sequence: 8,
      ackedMessageId: "msg_7",
      ackedSequence: 7,
      result: "APPLIED",
    });
    expect(ack.type).toBe("ACK");
    expect(ack.ack_required).toBe(false);
    expect(ack.payload.acked_message_id).toBe("msg_7");
  });

  it("builds a non-sticky correlated NACK", () => {
    const nack = buildNackV1({
      callSessionId: "cs_test",
      messageId: "nack_1",
      sequence: 9,
      rejectedMessageId: "msg_8",
      rejectedSequence: 8,
      code: "INVALID_STATE",
      retryable: false,
      terminal: false,
    });
    expect(nack.type).toBe("NACK");
    expect(nack.payload.code).toBe("INVALID_STATE");
    expect(nack.payload.terminal).toBe(false);
  });
});
