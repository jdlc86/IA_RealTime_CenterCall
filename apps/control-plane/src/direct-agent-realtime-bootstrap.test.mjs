import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DIRECT_AGENT_TOOL_NAMES,
  DIRECT_AGENT_TOOLS,
  directAgentRealtimeBootstrapPolicy,
} from "../.test-dist/direct-agent-realtime-bootstrap.js";
import { buildGeminiLiveInitialSetup } from "../.test-dist/gemini-live-command-adapter.js";

const v17Source = readFileSync(new URL("./call-session-v17.ts", import.meta.url), "utf8");

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

test("V17 consumes the shared bootstrap instead of owning a duplicate catalog", () => {
  assert.match(v17Source, /directAgentRealtimeBootstrapPolicy/);
  assert.doesNotMatch(v17Source, /const\s+AGENT_TOOLS\s*:/);
  assert.doesNotMatch(v17Source, /function\s+agentInstructions\s*\(/);
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
