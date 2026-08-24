import assert from "node:assert/strict";
import test from "node:test";
import { requireInboundRealtimeRouteReady } from "../.test-dist/inbound-realtime-route.js";
import {
  authorizeRealtimeProviderTraffic,
  requireRealtimeProviderTrafficAdmission,
} from "../.test-dist/realtime-provider-traffic-admission.js";

function selection(provider, tenantId = "tenant-canary", source = "TENANT_CONFIG") {
  return { tenantId, provider, source, overrideKey: "unused" };
}

const previewCanary = Object.freeze({
  environment: "preview",
  geminiEnabled: "true",
  geminiCanaryTenantId: "tenant-canary",
});

test("OpenAI baseline remains admitted without Gemini canary configuration", () => {
  const selected = selection("OPENAI", "tenant-openai");
  const admission = authorizeRealtimeProviderTraffic(selected, { environment: "production" });

  assert.equal(admission.scope, "BASELINE");
  assert.equal(requireInboundRealtimeRouteReady(selected, admission).transport, "OPENAI_DIRECT_SIP");
});

test("Gemini receives an opaque grant only for the exact preview canary tenant", () => {
  const selected = selection("GEMINI");
  const admission = authorizeRealtimeProviderTraffic(selected, previewCanary);

  assert.equal(admission.provider, "GEMINI");
  assert.equal(admission.tenantId, "tenant-canary");
  assert.equal(admission.selectionSource, "TENANT_CONFIG");
  assert.equal(admission.environment, "preview");
  assert.equal(admission.scope, "SINGLE_TENANT_CANARY");
  assert.equal(requireRealtimeProviderTrafficAdmission(selected, admission), admission);
  assert.equal(requireInboundRealtimeRouteReady(selected, admission).transport, "GEMINI_MEDIA_BRIDGE");
});

test("production admits only the explicitly enabled exact canary tenant", () => {
  const selected = selection("GEMINI");
  const admission = authorizeRealtimeProviderTraffic(selected, {
    environment: "production",
    geminiEnabled: "true",
    geminiCanaryTenantId: "tenant-canary",
  });
  assert.equal(admission.environment, "production");
  assert.equal(admission.scope, "SINGLE_TENANT_CANARY");
  assert.equal(requireRealtimeProviderTrafficAdmission(selected, admission), admission);
});

test("preview fails closed without the explicit flag or for any second tenant", () => {
  assert.throws(
    () => authorizeRealtimeProviderTraffic(selection("GEMINI"), {
      ...previewCanary,
      geminiEnabled: "false",
    }),
    /requires explicit preview enablement/,
  );
  assert.throws(
    () => authorizeRealtimeProviderTraffic(selection("GEMINI", "tenant-other"), previewCanary),
    /not enabled for tenant: tenant-other/,
  );
});

test("dev remains disabled even with the canary flag and exact tenant", () => {
  assert.throws(
    () => authorizeRealtimeProviderTraffic(selection("GEMINI"), {
      ...previewCanary,
      environment: "dev",
    }),
    /disabled in dev/,
  );
});

test("route admission rejects fabricated and cross-selection grants", () => {
  const canary = selection("GEMINI");
  const admission = authorizeRealtimeProviderTraffic(canary, previewCanary);

  assert.throws(
    () => requireInboundRealtimeRouteReady(canary, {
      ...admission,
    }),
    /not issued by the admission authority/,
  );
  assert.throws(
    () => requireInboundRealtimeRouteReady(selection("GEMINI", "tenant-other"), admission),
    /does not match immutable selection/,
  );
});
