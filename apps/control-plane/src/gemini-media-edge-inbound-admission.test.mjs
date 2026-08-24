import assert from "node:assert/strict";
import test from "node:test";
import { admitGeminiMediaEdgeInboundCall } from "../.test-dist/gemini-media-edge-inbound-admission.js";

const configuration = Object.freeze({
  schemaVersion: 1,
  tenantId: "tenant-canary",
  status: "active",
  business: { displayName: "Restaurante Canario", facts: {} },
  assistant: { name: "Lucía", greeting: "Hola", language: "es-ES" },
  realtime: { provider: "GEMINI" },
  tools: { allowed: ["restaurant_business_info"] },
});

const input = Object.freeze({
  calledNumber: "+34910000000",
  callerPhone: "+34600000000",
  answerCommandId: "answer-command-1",
  commandId: "stream-command-1",
  clientState: "opaque-client-state",
  provisioning: {
    callControlId: "call-control-1",
    edgeUrl: "wss://media.example.test/telnyx/gemini",
    targetLegs: "self",
    notAfterEpochMs: 2_000_000_000_000,
  },
  trafficPolicy: {
    environment: "preview",
    geminiEnabled: "true",
    geminiCanaryTenantId: "tenant-canary",
  },
  controlPlaneToken: "control-plane-token-never-logged",
});

function dependencies(trace, securityDecision = { decision: "ALLOW" }) {
  const callSession = {};
  return {
    async resolveTenant(calledNumber) {
      trace.push("TENANT");
      assert.equal(calledNumber, input.calledNumber);
      return {
        resolution: { tenantId: "tenant-canary", calledNumber, source: "called_number" },
        configuration,
      };
    },
    async selectProvider(received) {
      trace.push("PROVIDER_IMMUTABLE");
      assert.equal(received, configuration);
      return {
        tenantId: "tenant-canary",
        provider: "GEMINI",
        source: "TENANT_CONFIG",
        overrideKey: "tenant:runtime:realtime-provider:tenant-canary",
      };
    },
    async evaluateCallerSecurity(received) {
      trace.push("CALLER_SECURITY");
      assert.deepEqual(received, {
        tenantId: "tenant-canary",
        callerPhone: input.callerPhone,
        provider: "GEMINI",
      });
      return securityDecision;
    },
    async issueCredential(claims) {
      trace.push("CREDENTIAL");
      assert.equal(claims.tenantId, "tenant-canary");
      assert.equal(claims.callControlId, "call-control-1");
      return { credentialId: "credential-1", streamAuthToken: "signed-stream-token" };
    },
    async registerBootstrap(received) {
      trace.push("BOOTSTRAP");
      assert.equal(received.credentialId, "credential-1");
      assert.equal(received.binding.tenantId, "tenant-canary");
      assert.equal(received.context.assistantName, "Lucía");
      assert.equal(received.context.businessName, "Restaurante Canario");
    },
    async startCallSession(received) {
      trace.push("CALL_SESSION_REAL");
      assert.equal(received.selection.provider, "GEMINI");
      assert.equal(received.contract.binding.callControlId, "call-control-1");
      return callSession;
    },
    async requireSidebandReady(received) {
      trace.push("SIDEBAND_READY");
      assert.equal(received.callSession, callSession);
      assert.equal(received.selection.provider, "GEMINI");
    },
    async answerCall(request) {
      trace.push("ANSWER");
      assert.deepEqual(request, {
        callControlId: "call-control-1",
        commandId: "answer-command-1",
      });
      return { ok: true, httpStatus: 200, alreadyEnded: false };
    },
    async startStreaming(request) {
      trace.push("STREAMING_START");
      assert.deepEqual(request, {
        callControlId: "call-control-1",
        streamUrl: "wss://media.example.test/telnyx/gemini",
        streamAuthToken: "signed-stream-token",
        targetLegs: "self",
        commandId: "stream-command-1",
        clientState: "opaque-client-state",
      });
      return { ok: true, httpStatus: 200, alreadyEnded: false };
    },
  };
}

test("one composition owns the exact admission order and streaming_start is the final effect", async () => {
  const trace = [];
  const result = await admitGeminiMediaEdgeInboundCall(input, dependencies(trace));

  assert.deepEqual(trace, [
    "TENANT",
    "PROVIDER_IMMUTABLE",
    "CALLER_SECURITY",
    "CREDENTIAL",
    "BOOTSTRAP",
    "CALL_SESSION_REAL",
    "SIDEBAND_READY",
    "ANSWER",
    "STREAMING_START",
  ]);
  assert.equal(result.selection.provider, "GEMINI");
  assert.equal(result.admission.scope, "SINGLE_TENANT_CANARY");
  assert.equal(result.answering.httpStatus, 200);
  assert.equal(result.streaming.httpStatus, 200);
});

test("an inbound answer failure prevents streaming_start", async () => {
  const trace = [];
  const deps = dependencies(trace);
  deps.answerCall = async () => {
    trace.push("ANSWER");
    return { ok: false, httpStatus: 422, alreadyEnded: false, error: "Call has not been answered" };
  };

  await assert.rejects(
    admitGeminiMediaEdgeInboundCall(input, deps),
    /admission answer failed/,
  );
  assert.equal(trace.at(-1), "ANSWER");
  assert.equal(trace.includes("STREAMING_START"), false);
});

test("caller security rejection prevents every provider, bootstrap and media effect", async () => {
  const trace = [];
  await assert.rejects(
    admitGeminiMediaEdgeInboundCall(input, dependencies(trace, { decision: "BLOCK", reason: "RATE_LIMIT" })),
    /caller security rejected: RATE_LIMIT/,
  );
  assert.deepEqual(trace, ["TENANT", "PROVIDER_IMMUTABLE", "CALLER_SECURITY"]);
});

test("dev policy rejects before caller security and credential issuance", async () => {
  const trace = [];
  await assert.rejects(
    admitGeminiMediaEdgeInboundCall({
      ...input,
      trafficPolicy: { ...input.trafficPolicy, environment: "dev" },
    }, dependencies(trace)),
    /disabled in dev/,
  );
  assert.deepEqual(trace, ["TENANT", "PROVIDER_IMMUTABLE"]);
});

test("the same exact single tenant may run a controlled production E2E", async () => {
  const trace = [];
  const result = await admitGeminiMediaEdgeInboundCall({
    ...input,
    trafficPolicy: { ...input.trafficPolicy, environment: "production" },
  }, dependencies(trace));
  assert.equal(result.admission.environment, "production");
  assert.equal(result.admission.scope, "SINGLE_TENANT_CANARY");
  assert.equal(trace.at(-1), "STREAMING_START");
});

test("a non-Gemini selection never falls back into the Gemini admission sequence", async () => {
  const trace = [];
  const deps = dependencies(trace);
  deps.selectProvider = async () => {
    trace.push("PROVIDER_IMMUTABLE");
    return {
      tenantId: "tenant-canary",
      provider: "OPENAI",
      source: "TENANT_CONFIG",
      overrideKey: "unused",
    };
  };

  await assert.rejects(
    admitGeminiMediaEdgeInboundCall(input, deps),
    /requires immutable GEMINI selection, got OPENAI/,
  );
  assert.deepEqual(trace, ["TENANT", "PROVIDER_IMMUTABLE"]);
});
