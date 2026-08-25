import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryDiagnosticJournal } from "./diagnostic-journal.mjs";

test("diagnostic journal assigns stable idempotent ids and causal sequence", () => {
  const journal = new InMemoryDiagnosticJournal({ ttlMs: 60_000 });
  const first = journal.record({
    tenantId: "restaurante-centro",
    callControlId: "v3:test",
    stage: "GEMINI_SETUP_COMPLETE",
  }, 1_000_000);
  const second = journal.record({
    tenantId: "restaurante-centro",
    callControlId: "v3:test",
    stage: "VAD_SPEECH_STARTED",
    itemId: "gemini-candidate-1",
    rms: 0.2,
  }, 1_000_020);
  const readOne = journal.read("v3:test", 1_000_030);
  const readTwo = journal.read("v3:test", 1_000_040);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.causal_parent_event_id, first.event_id);
  assert.equal(readOne[0].event_id, readTwo[0].event_id);
  assert.equal(readOne[1].item_id, "gemini-candidate-1");
});

test("STT failure stores only stable category, status and bounded metrics", () => {
  const journal = new InMemoryDiagnosticJournal({ ttlMs: 60_000 });
  const event = journal.record({
    tenantId: "restaurante-centro",
    callControlId: "v3:test",
    stage: "STT_FAILED",
    component: "google-speech",
    severity: "error",
    errorCode: "STT_HTTP_ERROR",
    httpStatus: 400,
    itemId: "gemini-candidate-1",
    durationMs: 75,
    audioDurationMs: 920,
    chunkCount: 11,
    sampleCount: 14720,
    transcript: "Hola, me llamo Ana",
    audioPayload: "AAAA",
    providerBody: "private provider body",
  }, 2_000_000);
  const serialized = JSON.stringify(event);
  assert.equal(event.error_code, "STT_HTTP_ERROR");
  assert.equal(event.details.http_status, 400);
  assert.equal(event.duration_ms, 75);
  assert.equal(event.audio_duration_ms, 920);
  assert.equal(serialized.includes("Ana"), false);
  assert.equal(serialized.includes("AAAA"), false);
  assert.equal(serialized.includes("private provider body"), false);
  assert.equal(serialized.includes("transcript"), false);
});

test("governed speech failure stores its safe category without exception text", () => {
  const journal = new InMemoryDiagnosticJournal({ ttlMs: 60_000 });
  const event = journal.record({
    tenantId: "restaurante-centro",
    callControlId: "v3:test",
    stage: "GOVERNED_SPEECH_FAILED",
    severity: "error",
    errorCode: "PLAYBACK_NOT_IDLE",
    failureCategory: "PLAYBACK_NOT_IDLE",
    errorMessage: "private runtime failure text",
  }, 2_050_000);
  const serialized = JSON.stringify(event);
  assert.equal(event.error_code, "PLAYBACK_NOT_IDLE");
  assert.equal(event.details.failure_category, "PLAYBACK_NOT_IDLE");
  assert.equal(serialized.includes("private runtime failure text"), false);
});

test("semantic preselection uses backward-compatible safe details without adding a new top-level field", () => {
  const journal = new InMemoryDiagnosticJournal({ ttlMs: 60_000 });
  const event = journal.record({
    tenantId: "restaurante-centro",
    callControlId: "v3:test",
    stage: "SEMANTIC_PRESELECTION_COMPLETED",
    itemId: "gemini-candidate-1",
    selectedTool: "restaurant_conversation",
    directModelOutputAllowed: true,
    transcript: "quiero hacer una reserva",
    prompt: "private classifier prompt",
    providerBody: "private provider body",
  }, 2_100_000);
  const serialized = JSON.stringify(event);
  assert.equal("tool_name" in event, false);
  assert.equal(event.details.kind, "restaurant_conversation");
  assert.equal(event.details.authorized, true);
  assert.equal(event.details.direct_model_output_allowed, true);
  assert.equal(serialized.includes("quiero hacer una reserva"), false);
  assert.equal(serialized.includes("private classifier prompt"), false);
  assert.equal(serialized.includes("private provider body"), false);
  assert.equal(serialized.includes("transcript"), false);
});

test("deterministic latency diagnostics retain bounded aggregates and no conversational data", () => {
  const journal = new InMemoryDiagnosticJournal({ ttlMs: 60_000 });
  const event = journal.record({
    tenantId: "restaurante-centro",
    callControlId: "v3:test",
    stage: "DETERMINISTIC_SPEECH_END_TO_AUDIO_START",
    responseId: "response-1",
    durationMs: 812,
    observedMs: 812,
    p50Ms: 780,
    p95Ms: 1_140,
    sampleCount: 17,
    overBudget: false,
    transcript: "Juan López",
  }, 2_200_000);
  assert.equal(event.duration_ms, 812);
  assert.deepEqual(event.details, {
    observed_ms: 812,
    p50_ms: 780,
    p95_ms: 1_140,
    latency_sample_count: 17,
    over_budget: false,
  });
  assert.equal(JSON.stringify(event).includes("Juan López"), false);
});

test("diagnostic journal is bounded and expires old calls", () => {
  const journal = new InMemoryDiagnosticJournal({ maxCalls: 1, maxEventsPerCall: 2, ttlMs: 60_000 });
  journal.record({ tenantId: "tenant-a", callControlId: "call-a", stage: "MEDIA_SOCKET_AUTHORIZED" }, 3_000_000);
  journal.record({ tenantId: "tenant-a", callControlId: "call-a", stage: "TELNYX_START_AUTHORIZED" }, 3_000_001);
  journal.record({ tenantId: "tenant-a", callControlId: "call-a", stage: "GEMINI_SOCKET_OPEN" }, 3_000_002);
  assert.equal(journal.read("call-a", 3_000_003).length, 2);
  journal.record({ tenantId: "tenant-b", callControlId: "call-b", stage: "MEDIA_SOCKET_AUTHORIZED" }, 3_000_004);
  assert.equal(journal.read("call-a", 3_000_005).length, 0);
  assert.equal(journal.read("call-b", 3_060_005).length, 0);
});
