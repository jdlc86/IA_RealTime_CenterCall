import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DIRECT_AGENT_TOOL_NAMES,
  DIRECT_AGENT_TOOLS,
  directAgentRealtimeBootstrapPolicy,
} from "../.test-dist/direct-agent-realtime-bootstrap.js";
import { buildGeminiLiveInitialSetup } from "../.test-dist/gemini-live-command-adapter.js";
import { SEMANTIC_SECURITY_POLICY } from "../.test-dist/semantic-security-boundary.js";

const v17Source = readFileSync(new URL("./call-session-v17.ts", import.meta.url), "utf8");
const v29Source = readFileSync(new URL("./call-session-v29.ts", import.meta.url), "utf8");

test("direct-agent bootstrap owns one canonical instruction and tool catalog source", () => {
  const policy = directAgentRealtimeBootstrapPolicy({
    assistantName: "Lucía",
    businessName: "Milenium",
  });

  assert.equal(policy.tools, DIRECT_AGENT_TOOLS);
  assert.match(policy.instructions, /Eres Lucía, agente telefónica de Milenium/);
  assert.deepEqual(
    new Set(policy.tools.map((tool) => tool.name)),
    DIRECT_AGENT_TOOL_NAMES,
  );
});

test("canonical bootstrap carries the final semantic and temporal invariants before transport opens", () => {
  const policy = directAgentRealtimeBootstrapPolicy({
    assistantName: "Lucía",
    businessName: "Milenium",
  });

  assert.ok(policy.instructions.includes(SEMANTIC_SECURITY_POLICY));
  assert.match(policy.instructions, /CONTEXTO MULTIVUELTA:/);
  assert.match(policy.instructions, /no conviertas por ello un turno comunicativo dirigido en silencio/);
  assert.match(policy.instructions, /date_scope=CALLER_AUTHORIZED_RANGE/);
  assert.match(policy.instructions, /starts_at_source_text/);
  assert.match(policy.instructions, /nunca inventes ni reutilices un fragmento anterior/);
});

test("V17 consumes the shared bootstrap instead of owning a duplicate catalog", () => {
  assert.match(v17Source, /directAgentRealtimeBootstrapPolicy/);
  assert.doesNotMatch(v17Source, /const\s+AGENT_TOOLS\s*:/);
  assert.doesNotMatch(v17Source, /function\s+agentInstructions\s*\(/);
});

test("V29 runtime policy reuses the canonical direct-agent instructions", () => {
  assert.match(v29Source, /import\s*{\s*directAgentInstructions\s*}\s*from\s*["']\.\/direct-agent-realtime-bootstrap\.js["']/);
  assert.match(v29Source, /instructions:\s*directAgentInstructions\(this as any\)/);
  assert.doesNotMatch(v29Source, /function\s+v29Instructions\s*\(/);
  assert.doesNotMatch(v29Source, /SEMANTIC_RESERVATION_TIME_EVIDENCE_POLICY/);
});

test("the canonical direct-agent bootstrap translates into Gemini immutable setup", () => {
  const policy = directAgentRealtimeBootstrapPolicy({
    assistantName: "Lucía",
    businessName: "Milenium",
  });

  const message = buildGeminiLiveInitialSetup({
    model: "models/gemini-live",
    instructions: policy.instructions,
    tools: policy.tools,
    responseModalities: ["AUDIO"],
    enableInputTranscription: true,
    enableOutputTranscription: true,
  });

  assert.equal(message.setup.systemInstruction.parts[0].text, policy.instructions);
  assert.equal(message.setup.tools[0].functionDeclarations.length, policy.tools.length);
  assert.deepEqual(
    new Set(message.setup.tools[0].functionDeclarations.map((tool) => tool.name)),
    DIRECT_AGENT_TOOL_NAMES,
  );
});
