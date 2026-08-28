import assert from "node:assert/strict";
import test from "node:test";
import {
  FAST_HORIZONTAL_TOOL_POLICIES,
  FastToolAuthorizationKernel,
  buildFastToolAuthorityContract,
  defineFastToolPolicy,
  mergeFastToolPolicies,
} from "./fast-tool-authorization-kernel.mjs";

function kernelFor(name, policy) {
  return new FastToolAuthorizationKernel({
    policies: { [name]: policy },
    declaredTools: [{ name }],
  });
}

const context = Object.freeze({
  tenantId: "tenant-1",
  callControlId: "v3:call-1",
  callerTranscript: "Quiero reservar mañana a las nueve para cuatro personas",
});

test("semantic necessity requires grounded current-turn caller evidence", () => {
  const kernel = kernelFor("get_authoritative_datetime", FAST_HORIZONTAL_TOOL_POLICIES.get_authoritative_datetime);
  const allowed = kernel.authorize({
    id: "clock-1",
    name: "get_authoritative_datetime",
    args: {
      authorization: "SEMANTIC_NECESSITY",
      caller_authority_evidence: "reservar mañana a las nueve",
    },
  }, context);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.effect, "READ_CONTEXT");
  assert.equal(allowed.capability, "time.authoritative");

  const blocked = kernel.authorize({
    id: "clock-2",
    name: "get_authoritative_datetime",
    args: {
      authorization: "SEMANTIC_NECESSITY",
      caller_authority_evidence: "qué fecha es hoy",
    },
  }, context);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.status, "TOOL_AUTHORITY_EVIDENCE_MISMATCH");
});

test("transfer keeps semantic caller authority without rigid phrase matching", () => {
  const kernel = kernelFor("transfer_call", FAST_HORIZONTAL_TOOL_POLICIES.transfer_call);
  const transcript = "A ver si me puedes pasar con alguien del equipo, por favor";
  const allowed = kernel.authorize({
    id: "transfer-1",
    name: "transfer_call",
    args: {
      authorization: "EXPLICIT_REQUEST",
      caller_authority_evidence: "me puedes pasar con alguien del equipo",
    },
  }, { tenantId: "tenant-1", callControlId: "v3:call-1", callerTranscript: transcript });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.effect, "TERMINAL_CALL_ACTION");

  const wrongSource = kernel.authorize({
    id: "transfer-2",
    name: "transfer_call",
    args: {
      authorization: "SEMANTIC_NECESSITY",
      caller_authority_evidence: transcript,
    },
  }, { tenantId: "tenant-1", callControlId: "v3:call-1", callerTranscript: transcript });
  assert.equal(wrongSource.allowed, false);
  assert.equal(wrongSource.status, "TOOL_AUTHORITY_REQUIRED");
});

test("future business tools register declarative policy without kernel changes", () => {
  const policies = mergeFastToolPolicies(FAST_HORIZONTAL_TOOL_POLICIES, {
    create_reservation: defineFastToolPolicy({
      authority: "CALLER_REQUEST",
      effect: "MUTATE_BUSINESS_DATA",
      capability: "reservation.create",
    }),
    cancel_reservation: defineFastToolPolicy({
      authority: "EXPLICIT_CONFIRMATION",
      effect: "DESTRUCTIVE_ACTION",
      capability: "reservation.cancel",
    }),
  });
  const kernel = new FastToolAuthorizationKernel({
    policies,
    declaredTools: [{ name: "create_reservation" }, { name: "cancel_reservation" }],
  });

  const create = kernel.authorize({
    name: "create_reservation",
    args: {
      authorization: "CALLER_REQUEST",
      caller_authority_evidence: "Quiero reservar mañana a las nueve",
    },
  }, context);
  assert.equal(create.allowed, true);
  assert.equal(create.capability, "reservation.create");

  const cancel = kernel.authorize({
    name: "cancel_reservation",
    args: {
      authorization: "CALLER_REQUEST",
      caller_authority_evidence: "Quiero reservar mañana a las nueve",
    },
  }, context);
  assert.equal(cancel.allowed, false);
  assert.equal(cancel.status, "TOOL_AUTHORITY_REQUIRED");
});

test("declared tool without local policy fails closed at session construction boundary", () => {
  assert.throws(() => new FastToolAuthorizationKernel({
    policies: FAST_HORIZONTAL_TOOL_POLICIES,
    declaredTools: [{ name: "refund_customer" }],
  }), /policy required/);
});

test("horizontal minimum policies cannot be overridden by business extensions", () => {
  assert.throws(() => mergeFastToolPolicies(FAST_HORIZONTAL_TOOL_POLICIES, {
    transfer_call: defineFastToolPolicy({
      authority: "SYSTEM_AUTHORITY",
      effect: "TERMINAL_CALL_ACTION",
      capability: "call.transfer",
    }),
  }), /override is forbidden/);
});

test("tool authority contract injects required semantic authority and evidence", () => {
  const contract = buildFastToolAuthorityContract(
    "Consulta disponibilidad.",
    { type: "object", properties: { date: { type: "string" } }, required: ["date"] },
    defineFastToolPolicy({
      authority: "SEMANTIC_NECESSITY",
      effect: "READ_BUSINESS_DATA",
      capability: "reservation.read",
    }),
  );
  assert.deepEqual(contract.parametersJsonSchema.properties.authorization.enum, ["SEMANTIC_NECESSITY"]);
  assert.deepEqual(contract.parametersJsonSchema.required.sort(), ["authorization", "caller_authority_evidence", "date"].sort());
  assert.equal(contract.parametersJsonSchema.additionalProperties, false);
});
