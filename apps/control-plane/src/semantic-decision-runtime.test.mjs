import assert from "node:assert/strict";
import test from "node:test";
import {
  installSemanticDecisionPort,
  removeSemanticDecisionPort,
  semanticDecisionPortFor,
} from "../.test-dist/semantic-decision-runtime.js";

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

test("an external isolated decision port overrides the realtime-backed fallback only for its session", () => {
  const h = host();
  const requests = [];
  const external = { request(request) { requests.push(request); } };

  const fallback = semanticDecisionPortFor(h);
  installSemanticDecisionPort(h, external);
  assert.equal(semanticDecisionPortFor(h), external);

  const request = {
    instructions: "Return INTERRUPT or IGNORE only",
    inputText: "perdona",
    requestId: "decision-runtime-external-1",
    purpose: "barge_in",
    maxOutputTokens: 8,
  };
  semanticDecisionPortFor(h).request(request);
  assert.deepEqual(requests, [request]);
  assert.deepEqual(h.events, []);

  removeSemanticDecisionPort(h, external);
  assert.equal(semanticDecisionPortFor(h), fallback);
});

test("external semantic decision ownership is fail-closed", () => {
  const h = host();
  const first = { request() {} };
  const second = { request() {} };

  installSemanticDecisionPort(h, first);
  assert.doesNotThrow(() => installSemanticDecisionPort(h, first));
  assert.throws(() => installSemanticDecisionPort(h, second), /already installed/);
  assert.throws(() => removeSemanticDecisionPort(h, second), /ownership mismatch/);
  assert.equal(semanticDecisionPortFor(h), first);
  removeSemanticDecisionPort(h, first);
});
