import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const srcDir = fileURLToPath(new URL("./", import.meta.url));

function activeHighLayerSources() {
  const sources = [];
  for (let version = 31; version <= 54; version += 1) {
    for (const suffix of ["", "-rebuild", "-closure-guard", "-turn-boundaries", "-handoff-authorization", "-raw-vad-routing", "-barge-in-semantic-authority", "-sideband-lifecycle", "-authoritative-clock", "-provider-selection", "-reservation-date-scope", "-malformed-tool-authority", "-reservation-time-authority", "-close-confirmation-authority"]) {
      const path = `${srcDir}call-session-v${version}${suffix}.ts`;
      if (existsSync(path)) sources.push([path, readFileSync(path, "utf8")]);
    }
  }
  return sources;
}

test("active V31-V54 layers cannot request isolated decisions through the conversational command port", () => {
  const violations = [];
  for (const [path, source] of activeHighLayerSources()) {
    if (/\.requestTextDecision\s*\(/.test(source)) violations.push(path);
  }
  assert.deepEqual(violations, [], `isolated semantic decisions must use SemanticDecisionPort: ${violations.join(", ")}`);
});

test("semantic decision runtime is the explicit session-scoped compatibility boundary", () => {
  const runtime = readFileSync(new URL("./semantic-decision-runtime.ts", import.meta.url), "utf8");
  const port = readFileSync(new URL("./semantic-decision-port.ts", import.meta.url), "utf8");
  assert.match(runtime, /semanticDecisionPortFor/);
  assert.match(runtime, /EXTERNAL_DECISION_PORT_BY_HOST/);
  assert.match(runtime, /installSemanticDecisionPort/);
  assert.match(port, /provider\s*!==\s*"OPENAI"/);
  assert.match(port, /install an external isolated decision port/);
  assert.doesNotMatch(port, /requireRealtimeProviderCapabilities/);
});
