import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIRealtimeCommandAdapter } from "../.test-dist/openai-realtime-command-adapter.js";
import {
  clearConsolidatedCallerTurnForNextResponse,
  realtimeCommandPortFor,
  stageConsolidatedCallerTurnForNextResponse,
} from "../.test-dist/realtime-provider-runtime.js";

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

test("provider adapter gives one consolidated split turn to the semantic response", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  port.createSemanticResponse({
    callerTurnText: "Quiero reservar mañana a las nueve para cinco personas",
    purpose: "consolidated_caller_turn",
    metadata: { fragment_count: 2 },
  });

  assert.equal(h.events.length, 2);
  assert.equal(h.events[0].type, "conversation.item.create");
  const text = h.events[0].item.content[0].text;
  assert.match(text, /Quiero reservar mañana a las nueve para cinco personas/);
  assert.equal(h.events[1].type, "response.create");
  assert.equal(h.events[1].response.metadata.purpose, "consolidated_caller_turn");
  assert.equal(h.events[1].response.metadata.fragment_count, "2");
});

test("runtime consumes staged caller turn exactly once", () => {
  const h = host();
  const port = realtimeCommandPortFor(h);
  stageConsolidatedCallerTurnForNextResponse(h, "mañana a las nueve para cinco personas");
  port.createDefaultResponse();
  port.createDefaultResponse();

  assert.equal(h.events.length, 3);
  assert.equal(h.events[0].type, "conversation.item.create");
  assert.equal(h.events[1].type, "response.create");
  assert.deepEqual(h.events[2], { type: "response.create" });
});

test("new caller speech can clear an unconsumed consolidated turn", () => {
  const h = host();
  const port = realtimeCommandPortFor(h);
  stageConsolidatedCallerTurnForNextResponse(h, "stale split turn");
  clearConsolidatedCallerTurnForNextResponse(h);
  port.createDefaultResponse();
  assert.deepEqual(h.events, [{ type: "response.create" }]);
});
