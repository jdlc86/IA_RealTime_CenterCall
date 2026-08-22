import test from "node:test";
import assert from "node:assert/strict";
import { decideEndCallProposal } from "../.test-dist/core-closing-policy.js";
import { OpenAIRealtimeCommandAdapter } from "../.test-dist/openai-realtime-command-adapter.js";

test("ambiguous end-call proposal requires confirmation", () => {
  const decision = decideEndCallProposal(false, false, true);
  assert.equal(decision.action, "ASK_CONFIRMATION");
});

test("closure confirmation speech is isolated and cannot select a tool", () => {
  const sent = [];
  const adapter = new OpenAIRealtimeCommandAdapter({ send: (event) => sent.push(event) });

  adapter.speak({
    instructions: 'Pronuncia exactamente esta pregunta y nada más: "¿Quieres que finalice la llamada?"',
    exactText: "¿Quieres que finalice la llamada?",
    tools: "DISABLED",
    isolated: true,
    purpose: "close_confirmation_v41",
    metadata: { authority: "closure_guard_v41", pending_close: true },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "response.create");
  assert.equal(sent[0].response.tool_choice, "none");
  assert.equal(sent[0].response.conversation, "none");
  assert.equal(sent[0].response.metadata.purpose, "close_confirmation_v41");
  assert.equal(sent[0].response.metadata.authority, "closure_guard_v41");
  assert.equal(sent[0].response.input[0].role, "system");
  assert.match(sent[0].response.input[0].content[0].text, /¿Quieres que finalice la llamada\?/);
  assert.equal(sent[0].response.input.some((item) => item.role === "user"), false);
});

test("repeated end-call proposal remains acknowledgement-only while confirmation is pending", () => {
  const decision = decideEndCallProposal(true, false, true);
  assert.equal(decision.action, "ACK_PENDING");
});
