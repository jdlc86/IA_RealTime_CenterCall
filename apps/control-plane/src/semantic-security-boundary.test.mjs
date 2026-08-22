import test from "node:test";
import assert from "node:assert/strict";
import {
  RESTAURANT_SECURITY_BOUNDARY_TOOL,
  SEMANTIC_SECURITY_POLICY,
  SEMANTIC_SECURITY_SAFE_RESPONSE,
  SEMANTIC_SECURITY_TOOL_DEFINITION,
  parseSemanticSecurityIncident,
} from "../.test-dist/semantic-security-boundary.js";

test("semantic security tool uses a closed category schema without caller-controlled text", () => {
  assert.equal(SEMANTIC_SECURITY_TOOL_DEFINITION.name, RESTAURANT_SECURITY_BOUNDARY_TOOL);
  assert.deepEqual(SEMANTIC_SECURITY_TOOL_DEFINITION.parameters.required, ["category"]);
  assert.equal(SEMANTIC_SECURITY_TOOL_DEFINITION.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(SEMANTIC_SECURITY_TOOL_DEFINITION.parameters.properties), ["category"]);
});

test("semantic security incident parser accepts only governed categories", () => {
  assert.deepEqual(parseSemanticSecurityIncident('{"category":"PROMPT_EXFILTRATION"}'), {
    category: "PROMPT_EXFILTRATION",
  });
  assert.equal(parseSemanticSecurityIncident('{"category":"RESTAURANT_CONVERSATION"}'), null);
  assert.equal(parseSemanticSecurityIncident('{"category":"PROMPT_EXFILTRATION","transcript":"secret"}'), null);
  assert.equal(parseSemanticSecurityIncident("not-json"), null);
});

test("policy classifies intent instead of enumerating caller phrases and preserves legitimate explanations", () => {
  assert.match(SEMANTIC_SECURITY_POLICY, /Comprende la intención, no busques una frase literal/);
  assert.match(SEMANTIC_SECURITY_POLICY, /pregunta legítima sobre una acción visible/);
  assert.match(SEMANTIC_SECURITY_POLICY, /No uses restaurant_conversation/);
  assert.doesNotMatch(SEMANTIC_SECURITY_SAFE_RESPONSE, /prompt|tool|configuración|secreto/i);
});
