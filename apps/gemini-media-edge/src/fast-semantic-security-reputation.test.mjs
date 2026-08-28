import test from "node:test";
import assert from "node:assert/strict";
import {
  FAST_SEMANTIC_SECURITY_TOOL_NAME,
  createFastSemanticSecurityBoundaryHandler,
} from "./fast-semantic-security-boundary.mjs";

const CALL = {
  id: "tool-semsec-1",
  name: FAST_SEMANTIC_SECURITY_TOOL_NAME,
  args: { category: "ROLE_ESCALATION", authorization: "SEMANTIC_NECESSITY" },
};
const CONTEXT = {
  tenantId: "tenant-test",
  callControlId: "opaque-call",
  callerPhoneE164: "+34600000000",
};

test("semantic security handler sends only bounded identity and category to reputation sideband", async () => {
  let recorded = null;
  const handler = createFastSemanticSecurityBoundaryHandler({
    recordSemanticIncident: async (input) => {
      recorded = input;
      return { ok: true, status: "SECURITY_SIGNAL_RECORDED" };
    },
  });
  const result = await handler(CALL, CONTEXT);
  assert.deepEqual(recorded, {
    tenantId: "tenant-test",
    callControlId: "opaque-call",
    callerPhoneE164: "+34600000000",
    toolCallId: "tool-semsec-1",
    category: "ROLE_ESCALATION",
  });
  assert.equal(result.status, "SEMANTIC_SECURITY_INCIDENT_RECORDED");
  assert.equal(result.reputation_signal_status, "RECORDED");
  assert.equal(result.call_terminated, false);
  assert.equal(Object.hasOwn(result, "transcript"), false);
});

test("semantic security persistence failure does not terminate or throw into the voice session", async () => {
  const handler = createFastSemanticSecurityBoundaryHandler({
    recordSemanticIncident: async () => ({ ok: false, status: "SECURITY_SIGNAL_UNAVAILABLE" }),
  });
  const result = await handler(CALL, CONTEXT);
  assert.equal(result.ok, true);
  assert.equal(result.reputation_signal_status, "UNAVAILABLE");
  assert.equal(result.call_terminated, false);
});

test("semantic security refuses reputation persistence when caller identity is unavailable", async () => {
  let called = false;
  const handler = createFastSemanticSecurityBoundaryHandler({
    recordSemanticIncident: async () => { called = true; return { ok: true, status: "SECURITY_SIGNAL_RECORDED" }; },
  });
  const result = await handler(CALL, { tenantId: "tenant-test", callControlId: "opaque-call" });
  assert.equal(called, false);
  assert.equal(result.reputation_signal_status, "IDENTITY_UNAVAILABLE");
});
