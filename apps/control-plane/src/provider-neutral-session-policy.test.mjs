import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIRealtimeCommandAdapter } from "../.test-dist/openai-realtime-command-adapter.js";
import { realtimeCommandPortFor } from "../.test-dist/realtime-provider-runtime.js";

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

test("neutral session policy preserves the current OpenAI session.update wire shape", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  port.updateSessionPolicy({ instructions: "direct-agent", toolChoice: "AUTO" });
  assert.deepEqual(h.events, [{
    type: "session.update",
    session: {
      type: "realtime",
      instructions: "direct-agent",
      tool_choice: "auto",
    },
  }]);
});

test("provider runtime delegates neutral session policy to the active OpenAI adapter", () => {
  const h = host();
  realtimeCommandPortFor(h).updateSessionPolicy({ instructions: "same-behavior", toolChoice: "AUTO" });
  assert.deepEqual(h.events[0], {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: "same-behavior",
      tool_choice: "auto",
    },
  });
});
