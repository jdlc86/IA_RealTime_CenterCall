import { describe, expect, it } from "vitest";
import { parseEnvelopeV1 } from "../control-contract/v1";
import {
  INITIAL_GEMINI_CALL_LIFECYCLE_STATE,
  enterGeminiTrustRecovery,
  reduceGeminiCallLifecycle,
  type GeminiCallLifecycleState,
} from "./state";

function event(type: string, payload: Record<string, unknown>, sequence = 1) {
  return parseEnvelopeV1({
    protocol: "gemini-control.v1",
    call_session_id: "call-1",
    message_id: `${type}-${sequence}`,
    sequence,
    type,
    ack_required: true,
    payload,
  });
}

function apply(state: GeminiCallLifecycleState, type: string, payload: Record<string, unknown>, sequence = 1) {
  const decision = reduceGeminiCallLifecycle(state, event(type, payload, sequence));
  expect(decision.action).toBe("APPLY");
  if (decision.action !== "APPLY") throw new Error("expected APPLY");
  return decision.state;
}

describe("independent Gemini call lifecycle", () => {
  it("moves bootstrap through listening, caller activity and transcript gating", () => {
    let state = INITIAL_GEMINI_CALL_LIFECYCLE_STATE;
    state = apply(state, "EDGE_READY", { edge_session_id: "edge-1", provider_connection_epoch: 1 });
    expect(state.phase).toBe("CALL_BOOTSTRAP");
    state = apply(state, "MEDIA_STARTED", { stream_id: "stream-1" }, 2);
    expect(state.phase).toBe("LISTENING");
    state = apply(state, "CALLER_ACTIVITY_STARTED", { turn_id: "turn-1", generation_id_at_start: null }, 3);
    expect(state).toMatchObject({ phase: "CALLER_ACTIVE", activeTurnId: "turn-1" });
    state = apply(state, "CALLER_ACTIVITY_ENDED", { turn_id: "turn-1" }, 4);
    expect(state.phase).toBe("TURN_GATING");
    const transcript = reduceGeminiCallLifecycle(state, event("CALLER_TRANSCRIPT_READY", {
      turn_id: "turn-1",
      authority: "GOOGLE_STT_V2",
      is_final: true,
      transcript: "contenido efimero de prueba",
    }, 5));
    expect(transcript.action).toBe("ACCEPT_NO_EFFECT");
    expect(transcript.state.phase).toBe("TURN_GATING");
  });

  it("rejects caller end/transcript identities that do not match the active turn", () => {
    const active: GeminiCallLifecycleState = Object.freeze({
      phase: "CALLER_ACTIVE",
      activeTurnId: "turn-a",
      providerConnectionEpoch: 1,
      mediaStarted: true,
    });
    expect(reduceGeminiCallLifecycle(active, event("CALLER_ACTIVITY_ENDED", { turn_id: "turn-b" })).action)
      .toBe("INVALID_STATE");

    const gating = Object.freeze({ ...active, phase: "TURN_GATING" as const });
    expect(reduceGeminiCallLifecycle(gating, event("CALLER_TRANSCRIPT_READY", {
      turn_id: "turn-b", authority: "GOOGLE_STT_V2", is_final: true, transcript: "x",
    })).action).toBe("INVALID_STATE");
  });

  it("requires clean restart and increasing provider epoch for trust recovery", () => {
    const listening: GeminiCallLifecycleState = Object.freeze({
      phase: "LISTENING",
      activeTurnId: null,
      providerConnectionEpoch: 4,
      mediaStarted: true,
    });
    const recovering = enterGeminiTrustRecovery(listening);
    expect(recovering.phase).toBe("RECOVERING");

    const resumed = reduceGeminiCallLifecycle(recovering, event("PROVIDER_RECONNECTED", {
      previous_provider_connection_epoch: 4,
      provider_connection_epoch: 5,
      mode: "RESUMED",
    }));
    expect(resumed.action).toBe("INVALID_STATE");

    const clean = reduceGeminiCallLifecycle(recovering, event("PROVIDER_RECONNECTED", {
      previous_provider_connection_epoch: 4,
      provider_connection_epoch: 5,
      mode: "CLEAN_RESTART",
    }));
    expect(clean.action).toBe("APPLY");
    if (clean.action !== "APPLY") throw new Error("expected APPLY");
    expect(clean.state).toMatchObject({ phase: "LISTENING", providerConnectionEpoch: 5, activeTurnId: null });
  });

  it("makes terminal absorbing and rejects unowned provider-generation events", () => {
    const terminal = apply(INITIAL_GEMINI_CALL_LIFECYCLE_STATE, "MEDIA_CLOSED", { reason: "ENDED" });
    expect(terminal.phase).toBe("TERMINAL");
    expect(reduceGeminiCallLifecycle(terminal, event("EDGE_READY", {
      edge_session_id: "edge-2", provider_connection_epoch: 2,
    })).action).toBe("INVALID_STATE");

    const providerEvent = reduceGeminiCallLifecycle(INITIAL_GEMINI_CALL_LIFECYCLE_STATE, event("GEMINI_GENERATION_STARTED", {
      turn_id: null,
      generation_id: "gen-1",
      origin: "CALLER_TURN",
    }));
    expect(providerEvent.action).toBe("INVALID_STATE");
    if (providerEvent.action !== "INVALID_STATE") throw new Error("expected invalid state");
    expect(providerEvent.reason).toBe("EVENT_OWNER_NOT_IMPLEMENTED");
  });
});
