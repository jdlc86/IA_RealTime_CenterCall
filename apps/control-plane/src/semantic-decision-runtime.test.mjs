import assert from "node:assert/strict";
import test from "node:test";
import { semanticDecisionPortFor } from "../.test-dist/semantic-decision-runtime.js";

function host() {
  const events = [];
  return {
    events,
    send(event) { events.push(event); },
  };
}

test("semantic decision capability is stable per session host", () => {
  const h = host();
  assert.equal(semanticDecisionPortFor(h), semanticDecisionPortFor(h));
  assert.notEqual(semanticDecisionPortFor(h), semanticDecisionPortFor(host()));
});

test("current OpenAI baseline preserves isolated decision wire behavior through the dedicated capability", () => {
  const h = host();
  semanticDecisionPortFor(h).request({
    instructions: "Return CLOSE or CONTINUE only",
    inputText: "No, gracias",
    requestId: "decision-runtime-1",
    purpose: "contextual_close",
    maxOutputTokens: 8,
  });

  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].type, "response.create");
  assert.equal(h.events[0].event_id, "decision-runtime-1");
  assert.equal(h.events[0].response.conversation, "none");
  assert.deepEqual(h.events[0].response.output_modalities, ["text"]);
  assert.equal(h.events[0].response.tool_choice, "none");
  assert.equal(h.events[0].response.instructions, "Return CLOSE or CONTINUE only");
  assert.equal(h.events[0].response.max_output_tokens, 8);
  assert.equal(h.events[0].response.metadata.purpose, "contextual_close");
  assert.deepEqual(h.events[0].response.input, [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "No, gracias" }],
  }]);
});
