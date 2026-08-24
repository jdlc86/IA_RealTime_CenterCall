import assert from "node:assert/strict";
import test from "node:test";
import { createGeminiMediaEdgeSemanticDecisionCapability } from "../.test-dist/gemini-media-edge-semantic-decision.js";
import {
  installRealtimeProviderEventIngress,
  removeRealtimeProviderEventIngress,
} from "../.test-dist/realtime-provider-event-ingress-runtime.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function request() {
  return {
    purpose: "barge_in_classifier_rebuild",
    metadata: { source_item_id: "caller-item-7" },
    maxOutputTokens: 8,
    instructions: "Return INTERRUPT or IGNORE_CONFIRMED.",
    inputText: "Transcripción: hola, espera",
  };
}

test("Gemini isolated semantic decision never enters Live wire and returns correlated neutral events", async () => {
  const host = {};
  const events = [];
  const completed = deferred();
  installRealtimeProviderEventIngress(host, async (batch) => {
    events.push(...batch);
    if (batch[0]?.type === "TEXT_DECISION_COMPLETED") completed.resolve();
  });
  const calls = [];
  const capability = createGeminiMediaEdgeSemanticDecisionCapability({
    edgeUrl: "wss://edge.example.test/media",
    tenantId: "tenant-a",
    callControlId: "call-a",
    controlPlaneToken: "control-secret",
    capabilityHost: host,
  }, async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, text: "IGNORE_CONFIRMED" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  capability.port.request(request());
  await completed.promise;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://edge.example.test/internal/semantic-decision");
  assert.equal(calls[0].url.includes("control-secret"), false);
  assert.equal(calls[0].init.headers.Authorization, "Bearer control-secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    tenantId: "tenant-a",
    callControlId: "call-a",
    instructions: "Return INTERRUPT or IGNORE_CONFIRMED.",
    inputText: "Transcripción: hola, espera",
    maxOutputTokens: 8,
  });
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    type: "ASSISTANT_RESPONSE_STARTED",
    kind: "NORMAL",
    responseId: events[0].responseId,
    purpose: "barge_in_classifier_rebuild",
    sourceItemId: "caller-item-7",
  });
  assert.match(events[0].responseId, /^gemini_isolated_decision_/);
  assert.deepEqual(events[1], {
    type: "TEXT_DECISION_COMPLETED",
    responseId: events[0].responseId,
    text: "IGNORE_CONFIRMED",
  });

  capability.close();
  removeRealtimeProviderEventIngress(host);
});

test("isolated classifier failure resolves conservatively to INTERRUPT instead of destructive IGNORE", async () => {
  const host = {};
  const events = [];
  const completed = deferred();
  installRealtimeProviderEventIngress(host, async (batch) => {
    events.push(...batch);
    if (batch[0]?.type === "TEXT_DECISION_COMPLETED") completed.resolve();
  });
  const capability = createGeminiMediaEdgeSemanticDecisionCapability({
    edgeUrl: "wss://edge.example.test/media",
    tenantId: "tenant-a",
    callControlId: "call-a",
    controlPlaneToken: "control-secret",
    capabilityHost: host,
  }, async () => new Response(JSON.stringify({ ok: false, error: "inactive_session" }), { status: 409 }));

  capability.port.request(request());
  await completed.promise;
  assert.equal(events[1].type, "TEXT_DECISION_COMPLETED");
  assert.equal(events[1].text, "INTERRUPT");
  assert.equal(events[1].responseId, events[0].responseId);

  capability.close();
  removeRealtimeProviderEventIngress(host);
});

test("closed semantic decision capability rejects new work and suppresses in-flight completion", async () => {
  const host = {};
  const events = [];
  const releaseFetch = deferred();
  installRealtimeProviderEventIngress(host, async (batch) => { events.push(...batch); });
  const capability = createGeminiMediaEdgeSemanticDecisionCapability({
    edgeUrl: "wss://edge.example.test/media",
    tenantId: "tenant-a",
    callControlId: "call-a",
    controlPlaneToken: "control-secret",
    capabilityHost: host,
  }, async () => {
    await releaseFetch.promise;
    return new Response(JSON.stringify({ ok: true, text: "IGNORE_CONFIRMED" }), { status: 200 });
  });

  capability.port.request(request());
  while (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  capability.close();
  assert.throws(() => capability.port.request(request()), /closed/);
  releaseFetch.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "ASSISTANT_RESPONSE_STARTED");

  removeRealtimeProviderEventIngress(host);
});
