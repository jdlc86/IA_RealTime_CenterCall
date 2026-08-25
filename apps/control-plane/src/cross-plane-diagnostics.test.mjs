import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCrossPlaneDiagnosticEvent } from "../.test-dist/call-diagnostic-persistence-port.js";

function baseEvent() {
  return {
    event_id: "v3:test:media_edge:epoch:1",
    occurred_at: "2026-08-24T21:30:00.000Z",
    call_id: "v3:test",
    call_control_id: "v3:test",
    tenant_id: "restaurante-centro",
    plane: "provider",
    component: "google-speech",
    stage: "STT_FAILED",
    severity: "error",
    error_code: "STT_HTTP_ERROR",
    sequence: 1,
    item_id: "gemini-candidate-1",
    duration_ms: 83,
    audio_duration_ms: 960,
    chunk_count: 12,
    sample_count: 15360,
    details: { http_status: 400, reason: "STT_HTTP_ERROR" },
  };
}

test("cross-plane diagnostics preserve only bounded technical evidence", () => {
  const event = normalizeCrossPlaneDiagnosticEvent(baseEvent());
  assert.equal(event.stage, "STT_FAILED");
  assert.equal(event.details?.http_status, 400);
  assert.equal(event.duration_ms, 83);
  assert.equal(event.audio_duration_ms, 960);
  assert.equal(JSON.stringify(event).includes("transcript"), false);
});

test("cross-plane diagnostics preserve safe semantic tool identity and direct-output authority", () => {
  const event = normalizeCrossPlaneDiagnosticEvent({
    ...baseEvent(),
    plane: "media_edge",
    component: "gemini-media-edge",
    stage: "SEMANTIC_PRESELECTION_COMPLETED",
    severity: "info",
    error_code: null,
    tool_name: "restaurant_conversation",
    details: { direct_model_output_allowed: true },
  });
  assert.equal(event.tool_name, "restaurant_conversation");
  assert.equal(event.details?.direct_model_output_allowed, true);
  assert.equal(JSON.stringify(event).includes("transcript"), false);
});

test("cross-plane diagnostics reject transcript, audio and credential fields", () => {
  assert.throws(
    () => normalizeCrossPlaneDiagnosticEvent({ ...baseEvent(), transcript: "hola soy Ana" }),
    /forbidden field/,
  );
  assert.throws(
    () => normalizeCrossPlaneDiagnosticEvent({ ...baseEvent(), details: { audio_payload: "AAAA" } }),
    /forbidden field/,
  );
  assert.throws(
    () => normalizeCrossPlaneDiagnosticEvent({ ...baseEvent(), details: { credential_id: "secret" } }),
    /forbidden field/,
  );
});

test("cross-plane diagnostics reject unbounded or free-form error content", () => {
  assert.throws(
    () => normalizeCrossPlaneDiagnosticEvent({ ...baseEvent(), error_code: "HTTP 400 invalid provider body" }),
    /error_code/,
  );
  assert.throws(
    () => normalizeCrossPlaneDiagnosticEvent({ ...baseEvent(), duration_ms: 4_000_000 }),
    /duration_ms/,
  );
  assert.throws(
    () => normalizeCrossPlaneDiagnosticEvent({ ...baseEvent(), details: { reason: "caller said private words" } }),
    /string detail/,
  );
});
