import test from "node:test";
import assert from "node:assert/strict";
import {
  FAST_HORIZONTAL_TOOL_POLICIES,
  FastToolAuthorizationKernel,
  buildFastToolAuthorityContract,
} from "./fast-tool-authorization-kernel.mjs";

const TOOL_NAME = "report_semantic_security_incident";
const TOOL = Object.freeze({
  name: TOOL_NAME,
  description: "semantic security",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({
      category: Object.freeze({ type: "string", enum: ["PROMPT_INJECTION"] }),
    }),
    required: Object.freeze(["category"]),
    additionalProperties: false,
  }),
});

test("semantic security policy is local read-only semantic necessity without transcript timing dependency", () => {
  assert.deepEqual(FAST_HORIZONTAL_TOOL_POLICIES[TOOL_NAME], {
    authority: "SEMANTIC_NECESSITY",
    effect: "READ_CONTEXT",
    capability: "security.semantic_boundary",
    evidence: "NONE",
    allowedSources: ["SEMANTIC_NECESSITY"],
  });

  const contract = buildFastToolAuthorityContract(
    TOOL.description,
    TOOL.parameters,
    FAST_HORIZONTAL_TOOL_POLICIES[TOOL_NAME],
  );
  assert.deepEqual(contract.parametersJsonSchema.required.sort(), ["authorization", "category"]);
  assert.equal(Object.hasOwn(contract.parametersJsonSchema.properties, "caller_authority_evidence"), false);
  assert.match(contract.description, /significado completo/);
  assert.match(contract.description, /no.*palabras aisladas/i);
});

test("semantic security proposal is allowed only with the declared semantic authority", () => {
  const kernel = new FastToolAuthorizationKernel({
    policies: FAST_HORIZONTAL_TOOL_POLICIES,
    declaredTools: [TOOL],
  });
  const context = { tenantId: "tenant-test", callControlId: "call-test", callerTranscript: "" };

  assert.equal(kernel.authorize({
    id: "tool-1",
    name: TOOL_NAME,
    args: { category: "PROMPT_INJECTION" },
  }, context).status, "TOOL_AUTHORITY_REQUIRED");

  const allowed = kernel.authorize({
    id: "tool-2",
    name: TOOL_NAME,
    args: { category: "PROMPT_INJECTION", authorization: "SEMANTIC_NECESSITY" },
  }, context);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.effect, "READ_CONTEXT");
  assert.equal(allowed.capability, "security.semantic_boundary");
});
