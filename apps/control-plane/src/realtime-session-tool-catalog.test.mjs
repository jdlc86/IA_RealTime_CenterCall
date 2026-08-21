import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIRealtimeCommandAdapter } from "../.test-dist/openai-realtime-command-adapter.js";

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

test("provider-neutral session policy translates tool catalog only at the OpenAI edge", () => {
  const h = host();
  const port = new OpenAIRealtimeCommandAdapter(h);
  const tools = [{
    type: "function",
    name: "restaurant_business_info",
    description: "Información oficial",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  }];

  port.updateSessionPolicy({
    instructions: "Atiende solo el restaurante",
    toolChoice: "AUTO",
    tools,
  });

  assert.deepEqual(h.events, [{
    type: "session.update",
    session: {
      type: "realtime",
      instructions: "Atiende solo el restaurante",
      tool_choice: "auto",
      tools,
    },
  }]);
});
