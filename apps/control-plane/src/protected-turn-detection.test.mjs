import assert from "node:assert/strict";
import test from "node:test";
import {
  buildServerVad,
  restoreTurnDetectionEvent,
  suspendTurnDetectionEvent,
} from "../.test-dist/protected-turn-detection.js";

test("suspendTurnDetectionEvent disables turn detection completely", () => {
  const event = suspendTurnDetectionEvent();
  assert.equal(event.type, "session.update");
  assert.equal(event.session.audio.input.turn_detection, null);
});

test("buildServerVad restores tenant settings and normal barge-in", () => {
  const vad = buildServerVad({
    threshold: 0.62,
    prefixPaddingMs: 250,
    silenceDurationMs: 650,
    idleTimeoutMs: 12000,
  });
  assert.deepEqual(vad, {
    type: "server_vad",
    threshold: 0.62,
    prefix_padding_ms: 250,
    silence_duration_ms: 650,
    idle_timeout_ms: 12000,
    create_response: true,
    interrupt_response: true,
  });
});

test("restoreTurnDetectionEvent uses safe Realtime defaults when tenant omits VAD fields", () => {
  const event = restoreTurnDetectionEvent();
  assert.deepEqual(event.session.audio.input.turn_detection, {
    type: "server_vad",
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 500,
    idle_timeout_ms: 10000,
    create_response: true,
    interrupt_response: true,
  });
});
