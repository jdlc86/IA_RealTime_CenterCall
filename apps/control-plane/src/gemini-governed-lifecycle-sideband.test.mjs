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

test("governed lifecycle sideband preserves handoff identity and fails closed on unsupported input", () => {
  const sideband = runtime();
  assert.deepEqual(sideband.observe({
    type: "GOVERNED_EVENT",
    event: { type: "ASSISTANT_RESPONSE_STARTED", responseId: "handoff-1", kind: "HANDOFF", purpose: "human_handoff_announcement_v37" },
  }).events, [{
    type: "ASSISTANT_RESPONSE_STARTED",
    responseId: "handoff-1",
    kind: "HANDOFF",
    purpose: "human_handoff_announcement_v37",
  }]);
  assert.throws(
    () => sideband.observe({
      type: "GOVERNED_EVENT",
      event: { type: "ASSISTANT_RESPONSE_STARTED", responseId: "x", kind: "SEMANTIC" },
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

test("governed playback lifecycle preserves protected kind and exact response identity", () => {
  const sideband = runtime();
  const started = sideband.observe({
    type: "PLAYBACK_EVENT",
    event: { type: "ASSISTANT_AUDIO_STARTED", responseId: "recovery-1", kind: "RECOVERY" },
  });
  assert.deepEqual(started.events, [{
    type: "ASSISTANT_AUDIO_STARTED",
    responseId: "recovery-1",
    kind: "RECOVERY",
  }]);

  assert.throws(
    () => sideband.observe({
      type: "PLAYBACK_EVENT",
      event: { type: "ASSISTANT_AUDIO_STOPPED", responseId: "recovery-2", kind: "RECOVERY" },
    }),
    /identity mismatch/,
  );
  assert.throws(
    () => sideband.observe({
      type: "PLAYBACK_EVENT",
      event: { type: "ASSISTANT_AUDIO_STOPPED", responseId: "recovery-1", kind: "GREETING" },
    }),
    /kind mismatch/,
  );

  const stopped = sideband.observe({
    type: "PLAYBACK_EVENT",
    event: { type: "ASSISTANT_AUDIO_STOPPED", responseId: "recovery-1", kind: "RECOVERY" },
  });
  assert.deepEqual(stopped.events, [{
    type: "ASSISTANT_AUDIO_STOPPED",
    responseId: "recovery-1",
    kind: "RECOVERY",
  }]);
});
