import assert from "node:assert/strict";
import test from "node:test";
import { applyRealtimeSessionBootstrapPolicy } from "../.test-dist/realtime-session-bootstrap-policy.js";
import { authorizeRealtimeProviderTraffic } from "../.test-dist/realtime-provider-traffic-admission.js";
import { bindAdmittedRealtimeProvider } from "../.test-dist/realtime-provider-runtime.js";

test("OpenAI startup policy preserves the current runtime session update", () => {
  const host = { events: [], send(event) { this.events.push(event); } };
  const result = applyRealtimeSessionBootstrapPolicy(host, {
    instructions: "canonical direct-agent policy",
    toolChoice: "AUTO",
  });

  assert.deepEqual(result, { provider: "OPENAI", mode: "RUNTIME_UPDATE" });
  assert.deepEqual(host.events, [{
    type: "session.update",
    session: {
      type: "realtime",
      instructions: "canonical direct-agent policy",
      tool_choice: "auto",
    },
  }]);
});

test("Gemini startup policy is owned by the admitted immutable media-edge bootstrap", () => {
  const host = {};
  const selection = {
    tenantId: "tenant-canary",
    provider: "GEMINI",
    source: "TENANT_CONFIG",
    overrideKey: "ingress-affinity",
  };
  const admission = authorizeRealtimeProviderTraffic(selection, {
    environment: "production",
    geminiEnabled: "true",
    geminiCanaryTenantId: "tenant-canary",
  });
  bindAdmittedRealtimeProvider(host, selection, admission);

  assert.deepEqual(
    applyRealtimeSessionBootstrapPolicy(host, {
      instructions: "canonical direct-agent policy already registered at the edge",
      toolChoice: "AUTO",
    }),
    { provider: "GEMINI", mode: "IMMUTABLE_BOOTSTRAP" },
  );
});

test("an immutable-only provider cannot silently absorb a non-instruction policy", () => {
  const host = {};
  const selection = {
    tenantId: "tenant-canary-invalid",
    provider: "GEMINI",
    source: "TENANT_CONFIG",
    overrideKey: "ingress-affinity",
  };
  bindAdmittedRealtimeProvider(host, selection, authorizeRealtimeProviderTraffic(selection, {
    environment: "production",
    geminiEnabled: "true",
    geminiCanaryTenantId: "tenant-canary-invalid",
  }));

  assert.throws(
    () => applyRealtimeSessionBootstrapPolicy(host, { toolChoice: "AUTO" }),
    /cannot absorb a non-instruction startup policy/,
  );
});
