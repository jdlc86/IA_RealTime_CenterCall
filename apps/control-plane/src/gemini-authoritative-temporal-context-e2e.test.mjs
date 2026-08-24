import assert from "node:assert/strict";
import test from "node:test";
import { authoritativeTemporalContextPortFor } from "../.test-dist/authoritative-temporal-context-runtime.js";
import { withAuthoritativeTemporalToolResult } from "../.test-dist/authoritative-temporal-tool-result.js";
import { connectGeminiMediaEdgeSidebandToProviderHost } from "../.test-dist/gemini-media-edge-sideband-connector.js";
import { externalRealtimeProviderCommandPortFor } from "../.test-dist/realtime-provider-external-command-runtime.js";
import {
  installRealtimeProviderEventIngress,
  removeRealtimeProviderEventIngress,
} from "../.test-dist/realtime-provider-event-ingress-runtime.js";
import { enforceReservationRelativeDateAuthority } from "../.test-dist/reservation-relative-date-authority-runtime.js";

class FakeSocket {
  constructor() { this.readyState = 1; this.sent = []; this.listeners = new Map(); this.accepted = false; }
  accept() { this.accepted = true; }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; }
  addEventListener(type, listener) { const listeners = this.listeners.get(type) ?? []; listeners.push(listener); this.listeners.set(type, listeners); }
  emit(type, data = undefined) { for (const listener of this.listeners.get(type) ?? []) listener(type === "message" ? { data } : {}); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("Gemini temporal E2E turns a post-rollover caller transcript into one correlated fail-closed TOOL_RESULT", async () => {
  const socket = new FakeSocket();
  const host = {};
  const completed = deferred();
  const callerNow = new Date("2026-08-23T22:01:00Z");
  const resultNow = new Date("2026-08-23T22:01:02Z");
  let capturedTemporalPort = null;
  let outcome = null;

  const ingress = async (events) => {
    try {
      const event = events[0];
      if (event?.type === "CALLER_TRANSCRIPT_COMPLETED") {
        capturedTemporalPort = authoritativeTemporalContextPortFor(host);
        capturedTemporalPort.refresh({
          baseInstructions: "CANONICAL_POLICY",
          now: callerNow,
          callerTurn: { itemId: event.itemId, transcript: event.transcript },
        });
      }
      if (event?.type === "SEMANTIC_TOOL_SELECTED") {
        const args = JSON.parse(event.arguments);
        const gemini = externalRealtimeProviderCommandPortFor(host, "GEMINI");
        assert.ok(gemini, "exact Gemini sideband command port must still be installed");
        const correlatedTemporalCommand = {
          submitToolResult(request) {
            gemini.submitToolResult(withAuthoritativeTemporalToolResult(request, resultNow));
          },
          createDefaultResponse() { gemini.createDefaultResponse(); },
        };
        outcome = enforceReservationRelativeDateAuthority(host, {
          callId: event.callId,
          toolName: event.name,
          requestedLocalDate: args.starts_at.slice(0, 10),
          authorizeSemanticTool: () => true,
        }, correlatedTemporalCommand);
        completed.resolve();
      }
    } catch (error) {
      completed.reject(error);
    }
  };
  installRealtimeProviderEventIngress(host, ingress);
  const connection = await connectGeminiMediaEdgeSidebandToProviderHost({
    edgeUrl: "wss://media.example.test/telnyx/gemini",
    tenantId: "tenant-a",
    callControlId: "call-a",
    controlPlaneToken: "control-token-placeholder",
    capabilityHost: host,
  }, async () => ({ status: 101, webSocket: socket }));

  try {
    socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { setupComplete: {} } }));
    socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: {
      type: "CALLER_SPEECH_STARTED",
      itemId: "caller-after-rollover",
      playbackResponseIdAtStart: null,
    } }));
    socket.emit("message", JSON.stringify({ type: "CALLER_EVENT", event: {
      type: "CALLER_TRANSCRIPT_COMPLETED",
      itemId: "caller-after-rollover",
      transcript: "mañana a las nueve",
    } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.emit("message", JSON.stringify({ type: "GEMINI_EVENT", message: { toolCall: { functionCalls: [{
      id: "reservation-call-1",
      name: "restaurant_reservation_create",
      args: { starts_at: "2026-08-24T09:00:00+02:00", party_size: 2 },
    }] } } }));
    await completed.promise;

    assert.equal(outcome.handled, true);
    assert.equal(outcome.decision.action, "BLOCK_MISMATCH");
    const outbound = socket.sent.map((value) => JSON.parse(value));
    const toolResults = outbound.filter((message) => message.type === "TOOL_RESULT");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].callId, "reservation-call-1");
    assert.equal(toolResults[0].toolName, "restaurant_reservation_create");
    assert.equal(toolResults[0].output.status, "RELATIVE_DATE_MISMATCH");
    assert.equal(toolResults[0].output.authoritative_local_date, "2026-08-25");
    assert.equal(toolResults[0].output.authoritative_temporal_context.now_iso, "2026-08-24T00:01:02+02:00");
    assert.equal(outbound.some((message) => "clientContent" in message), false);
    assert.equal(outbound.some((message) => "realtimeInput" in message), false);
    assert.equal(outbound.some((message) => "setup" in message), false);
  } finally {
    connection.close();
    removeRealtimeProviderEventIngress(host, ingress);
  }

  assert.ok(capturedTemporalPort);
  assert.throws(() => capturedTemporalPort.decideReservationDate("2026-08-25"), /is closed/);
  assert.equal(externalRealtimeProviderCommandPortFor(host, "GEMINI"), null);
});
