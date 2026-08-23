import assert from "node:assert/strict";
import test from "node:test";
import {
  planInboundRealtimeRoute,
  requireInboundRealtimeRouteReady,
} from "../.test-dist/inbound-realtime-route.js";

function selection(provider, source = "TENANT_CONFIG") {
  return { tenantId: "tenant-a", provider, source, overrideKey: "unused" };
}

test("OpenAI ingress maps only to direct OpenAI SIP", () => {
  assert.deepEqual(planInboundRealtimeRoute(selection("OPENAI")), {
    provider: "OPENAI",
    source: "TENANT_CONFIG",
    transport: "OPENAI_DIRECT_SIP",
  });
  assert.equal(requireInboundRealtimeRouteReady(selection("OPENAI")).transport, "OPENAI_DIRECT_SIP");
});

test("Gemini topology maps only to its media bridge but remains traffic-disabled", () => {
  assert.deepEqual(planInboundRealtimeRoute(selection("GEMINI")), {
    provider: "GEMINI",
    source: "TENANT_CONFIG",
    transport: "GEMINI_MEDIA_BRIDGE",
  });
  assert.throws(
    () => requireInboundRealtimeRouteReady(selection("GEMINI")),
    /registered but not enabled for traffic: GEMINI/,
  );
});

test("admission never falls back across providers", () => {
  assert.throws(() => requireInboundRealtimeRouteReady(selection("GEMINI")));
  assert.equal(planInboundRealtimeRoute(selection("GEMINI")).provider, "GEMINI");
  assert.equal(planInboundRealtimeRoute(selection("OPENAI")).provider, "OPENAI");
});
