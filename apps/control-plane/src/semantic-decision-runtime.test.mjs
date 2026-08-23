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

  assert.equal(h.events.length, 2);
  assert.equal(h.events[0].type, "conversation.item.create");
  assert.equal(h.events[1].type, "response.create");
  assert.equal(h.events[1].response.metadata.request_id, "decision-runtime-1");
  assert.equal(h.events[1].response.metadata.realtime_response_kind, "TEXT_DECISION");
});
