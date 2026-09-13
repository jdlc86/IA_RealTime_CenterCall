import { describe, expect, it } from "vitest";
import { parseVerifiedTelnyxIncomingCall } from "./incoming-call";

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      id: "evt-1",
      occurred_at: "2026-08-26T11:30:00.000Z",
      event_type: "call.initiated",
      payload: {
        direction: "incoming",
        call_control_id: "v3:call-control-1",
        call_session_id: "telnyx-session-1",
        to: "+34910000000",
        from: "+34600000000",
      },
      ...overrides,
    },
  });
}

describe("verified Telnyx incoming call parser", () => {
  it("extracts only signed transport identity", () => {
    expect(parseVerifiedTelnyxIncomingCall(body())).toEqual({
      eventId: "evt-1",
      occurredAt: "2026-08-26T11:30:00.000Z",
      occurredAtEpochMs: Date.parse("2026-08-26T11:30:00.000Z"),
      callControlId: "v3:call-control-1",
      telnyxCallSessionId: "telnyx-session-1",
      calledNumber: "+34910000000",
      callerNumber: "+34600000000",
    });
  });

  it("rejects non-incoming and non-initiation events", () => {
    expect(() => parseVerifiedTelnyxIncomingCall(body({ event_type: "call.hangup" }))).toThrow(/call\.initiated/i);
    const outgoing = JSON.stringify({
      data: {
        id: "evt-2",
        occurred_at: "2026-08-26T11:30:00.000Z",
        event_type: "call.initiated",
        payload: { direction: "outgoing", call_control_id: "c", to: "+1" },
      },
    });
    expect(() => parseVerifiedTelnyxIncomingCall(outgoing)).toThrow(/not incoming/i);
  });

  it("rejects malformed JSON, missing immutable IDs and invalid occurred_at", () => {
    expect(() => parseVerifiedTelnyxIncomingCall("{")) .toThrow(/valid JSON/i);
    expect(() => parseVerifiedTelnyxIncomingCall(body({ id: "" }))).toThrow(/event id/i);
    expect(() => parseVerifiedTelnyxIncomingCall(body({ occurred_at: "not-a-date" }))).toThrow(/occurred_at/i);
  });

  it("does not require optional caller or Telnyx call-session identity", () => {
    const value = JSON.stringify({
      data: {
        id: "evt-3",
        occurred_at: "2026-08-26T11:31:00.000Z",
        event_type: "call.initiated",
        payload: { direction: "incoming", call_control_id: "cc-3", to: "+34910000001" },
      },
    });
    const parsed = parseVerifiedTelnyxIncomingCall(value);
    expect(parsed.callerNumber).toBeNull();
    expect(parsed.telnyxCallSessionId).toBeNull();
  });
});
