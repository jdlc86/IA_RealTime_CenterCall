import test from "node:test";
import assert from "node:assert/strict";
import { requireGeminiMediaEdgeProvisioningReady } from "../.test-dist/gemini-media-edge-admission-composition.js";
import { authorizeRealtimeProviderTraffic } from "../.test-dist/realtime-provider-traffic-admission.js";

function selection(provider) {
  return {
    tenantId: "tenant-madrid",
    provider,
    source: "TENANT_CONFIG",
    overrideKey: "tenant:runtime:realtime-provider:tenant-madrid",
  };
}

const provisioning = Object.freeze({
  callControlId: "call-123",
  edgeUrl: "wss://media.example.test/telnyx/gemini",
  targetLegs: "self",
  notAfterEpochMs: 1_800_000_000_000,
});

test("traffic-disabled GEMINI fails admission before the media-edge credential issuer is invoked", async () => {
  let issued = 0;

  await assert.rejects(
    requireGeminiMediaEdgeProvisioningReady(
      selection("GEMINI"),
      provisioning,
      async () => {
        issued += 1;
        return { streamAuthToken: "must-never-be-issued" };
      },
    ),
    /registered but not enabled for traffic: GEMINI/,
  );

  assert.equal(issued, 0);
});

test("an admitted OPENAI route cannot accidentally invoke the Gemini credential issuer", async () => {
  let issued = 0;

  await assert.rejects(
    requireGeminiMediaEdgeProvisioningReady(
      selection("OPENAI"),
      provisioning,
      () => {
        issued += 1;
        return { streamAuthToken: "wrong-provider-token" };
      },
    ),
    /requires GEMINI_MEDIA_BRIDGE, got OPENAI\/OPENAI_DIRECT_SIP/,
  );

  assert.equal(issued, 0);
});

test("invalid Gemini provisioning input cannot move credential issuance ahead of admission", async () => {
  let issued = 0;

  await assert.rejects(
    requireGeminiMediaEdgeProvisioningReady(
      selection("GEMINI"),
      { ...provisioning, edgeUrl: "ws://insecure.example.test" },
      () => {
        issued += 1;
        return { streamAuthToken: "must-never-be-issued" };
      },
    ),
    /registered but not enabled for traffic: GEMINI/,
  );

  assert.equal(issued, 0);
});

test("an issued preview canary grant permits exactly one bound credential result", async () => {
  const selected = selection("GEMINI");
  const admission = authorizeRealtimeProviderTraffic(selected, {
    environment: "preview",
    geminiEnabled: "true",
    geminiCanaryTenantId: "tenant-madrid",
  });
  let issued = 0;

  const provisioned = await requireGeminiMediaEdgeProvisioningReady(
    selected,
    provisioning,
    (claims) => {
      issued += 1;
      assert.equal(claims.tenantId, "tenant-madrid");
      return { credentialId: "credential-preview-1", streamAuthToken: "signed-preview-token" };
    },
    admission,
  );

  assert.equal(issued, 1);
  assert.equal(provisioned.credentialId, "credential-preview-1");
  assert.equal(provisioned.contract.binding.provider, "GEMINI");
  assert.equal(provisioned.contract.secret.streamAuthToken, "signed-preview-token");
});
