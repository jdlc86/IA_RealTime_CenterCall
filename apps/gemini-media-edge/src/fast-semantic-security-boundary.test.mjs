import test from "node:test";
import assert from "node:assert/strict";
import {
  FAST_SEMANTIC_SECURITY_CATEGORIES,
  FAST_SEMANTIC_SECURITY_TOOL_NAME,
  executeFastSemanticSecurityBoundary,
  safeFastSemanticSecurityDiagnostic,
} from "./fast-semantic-security-boundary.mjs";

test("Fast semantic security handler records only a bounded category and has no persistent effect", () => {
  for (const category of FAST_SEMANTIC_SECURITY_CATEGORIES) {
    const result = executeFastSemanticSecurityBoundary({
      name: FAST_SEMANTIC_SECURITY_TOOL_NAME,
      args: { category, authorization: "SEMANTIC_NECESSITY" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "SEMANTIC_SECURITY_INCIDENT_RECORDED");
    assert.equal(result.category, category);
    assert.equal(result.persistent_reputation_changed, false);
    assert.equal(result.call_terminated, false);
    assert.equal(Object.hasOwn(result, "caller_authority_evidence"), false);
    assert.equal(Object.hasOwn(result, "transcript"), false);
  }
});

test("Fast semantic security handler fails closed on undeclared category or wrong tool", () => {
  assert.throws(() => executeFastSemanticSecurityBoundary({
    name: FAST_SEMANTIC_SECURITY_TOOL_NAME,
    args: { category: "UNKNOWN" },
  }), /category is invalid/);
  assert.throws(() => executeFastSemanticSecurityBoundary({
    name: "other_tool",
    args: { category: "PROMPT_INJECTION" },
  }), /tool name is invalid/);
});

test("Fast semantic security diagnostic is category-only and never copies tool arguments", () => {
  const result = executeFastSemanticSecurityBoundary({
    name: FAST_SEMANTIC_SECURITY_TOOL_NAME,
    args: { category: "PROMPT_EXFILTRATION" },
  });
  assert.deepEqual(safeFastSemanticSecurityDiagnostic({
    name: FAST_SEMANTIC_SECURITY_TOOL_NAME,
    args: { category: "PROMPT_EXFILTRATION", secret: "must-not-leak" },
  }, result), {
    kind: "SEMANTIC_SECURITY_INCIDENT_RECORDED",
    category: "PROMPT_EXFILTRATION",
  });
});
