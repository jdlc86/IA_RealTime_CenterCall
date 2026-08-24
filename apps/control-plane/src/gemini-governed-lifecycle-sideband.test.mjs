import assert from "node:assert/strict";
import test from "node:test";
import { GeminiMediaEdgeSidebandRuntime } from "../.test-dist/gemini-media-edge-sideband-runtime.js";

function runtime() {
  return new GeminiMediaEdgeSidebandRuntime(() => {});
}

test("governed lifecycle sideband preserves correlated protected response events", () => {
  const sideband = runtime();
  const started = sideband.observe({
    type: "GOVERNED_EVENT",
    event: {
      type: "ASSISTANT_RESPONSE_STARTED",
      responseId: "greeting-1",
      kind: "GREETING",
      purpose: "initial_greeting",
    },
  });
  assert.deepEqual(started.events, [{
    type: "ASSISTANT_RESPONSE_STARTED",
    responseId: "greeting-1",
    kind: "GREETING",
    purpose: "initial_greeting",
  }]);

  const completed = sideband.observe({
    type: "GOVERNED_EVENT",
    event: {
      type: "ASSISTANT_RESPONSE_COMPLETED",
      responseId: "greeting-1",
      kind: "GREETING",
      status: "completed",
    },
  });
  assert.deepEqual(completed.events, [{
    type: "ASSISTANT_RESPONSE_COMPLETED",
    responseId: "greeting-1",
    kind: "GREETING",
    status: "completed",
  }]);
});

test("governed lifecycle sideband fails closed on unsupported kind or event type", () => {
  const sideband = runtime();
  assert.throws(
    () => sideband.observe({
      type: "GOVERNED_EVENT",
      event: { type: "ASSISTANT_RESPONSE_STARTED", responseId: "x", kind: "TERMINAL" },
    }),
    /kind is unsupported/,
  );
  assert.throws(
    () => sideband.observe({
      type: "GOVERNED_EVENT",
      event: { type: "ASSISTANT_AUDIO_STARTED", responseId: "x", kind: "GREETING" },
    }),
    /event type is unsupported/,
  );
});
