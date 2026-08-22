import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIRealtimeCommandAdapter } from "../.test-dist/openai-realtime-command-adapter.js";
import {
  installRealtimeSessionPolicyTransform,
  realtimeCommandPortFor,
} from "../.test-dist/realtime-provider-runtime.js";

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

test("session policy transform governs instructions before provider translation", () => {
  const h = host();
  installRealtimeSessionPolicyTransform(h, (update) => ({
    ...update,
    instructions: update.instructions ? `${update.instructions}\n\nclosing-guidance` : update.instructions,
  }));
  realtimeCommandPortFor(h).updateSessionPolicy({ instructions: "direct-agent", toolChoice: "AUTO" });
  assert.deepEqual(h.events[0], {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: "direct-agent\n\nclosing-guidance",
      tool_choice: "auto",
    },
  });
});

test("multiple session policy transforms compose in installation order", () => {
  const h = host();
  installRealtimeSessionPolicyTransform(h, (update) => ({
    ...update,
    instructions: update.instructions ? `${update.instructions}\nclock` : update.instructions,
  }));
  installRealtimeSessionPolicyTransform(h, (update) => ({
    ...update,
    instructions: update.instructions ? `${update.instructions}\nclosing` : update.instructions,
  }));
  realtimeCommandPortFor(h).updateSessionPolicy({ instructions: "direct-agent", toolChoice: "AUTO" });
  assert.deepEqual(h.events[0].session.instructions, "direct-agent\nclock\nclosing");
});

test("session policy transform leaves updates without instructions structurally intact", () => {
  const h = host();
  installRealtimeSessionPolicyTransform(h, (update) => ({
    ...update,
    instructions: update.instructions ? `${update.instructions}\nextra` : update.instructions,
  }));
  realtimeCommandPortFor(h).updateSessionPolicy({ toolChoice: "NONE" });
  assert.deepEqual(h.events[0], {
    type: "session.update",
    session: { type: "realtime", tool_choice: "none" },
  });
});
