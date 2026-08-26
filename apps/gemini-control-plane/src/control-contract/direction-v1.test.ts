import { describe, expect, it } from "vitest";
import { parseEnvelopeV1 } from "./v1";
import { assertEnvelopeDirectionV1, isAllowedDirectionV1 } from "./direction-v1";

function envelope(type: string, payload: Record<string, unknown>) {
  return parseEnvelopeV1({
    protocol: "gemini-control.v1",
    call_session_id: "call-1",
    message_id: `message-${type}`,
    sequence: 1,
    type,
    ack_required: type !== "ACK" && type !== "NACK",
    payload,
  });
}

describe("gemini-control.v1 direction", () => {
  it("allows Edge events only toward Worker", () => {
    const ready = envelope("EDGE_READY", { edge_session_id: "edge-1", provider_connection_epoch: 1 });
    expect(isAllowedDirectionV1(ready.type, "EDGE_TO_WORKER")).toBe(true);
    expect(isAllowedDirectionV1(ready.type, "WORKER_TO_EDGE")).toBe(false);
    expect(assertEnvelopeDirectionV1(ready, "EDGE_TO_WORKER")).toBe(ready);
  });

  it("allows Worker commands only toward Edge", () => {
    const authorized = envelope("TURN_AUTHORIZED", { command_id: "cmd-1", turn_id: "turn-1" });
    expect(isAllowedDirectionV1(authorized.type, "WORKER_TO_EDGE")).toBe(true);
    expect(isAllowedDirectionV1(authorized.type, "EDGE_TO_WORKER")).toBe(false);
    expect(() => assertEnvelopeDirectionV1(authorized, "EDGE_TO_WORKER")).toThrow(/invalid for EDGE_TO_WORKER/);
  });

  it("allows ACK NACK and SYNC bidirectionally", () => {
    expect(isAllowedDirectionV1("ACK", "EDGE_TO_WORKER")).toBe(true);
    expect(isAllowedDirectionV1("ACK", "WORKER_TO_EDGE")).toBe(true);
    expect(isAllowedDirectionV1("NACK", "EDGE_TO_WORKER")).toBe(true);
    expect(isAllowedDirectionV1("SYNC", "WORKER_TO_EDGE")).toBe(true);
  });
});
