import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_QUARANTINE_AUDIO_BYTES,
  MAX_QUARANTINE_DURATION_MS,
  TurnAuthorizationQuarantine,
} from "./authorization-quarantine.mjs";

test("quarantine releases buffered PCM and tools only after exact turn authorization", () => {
  const owner = new TurnAuthorizationQuarantine({ maxAudioBytes: 32, maxToolCalls: 2 });
  owner.begin("turn-1", "gen-1");
  assert.deepEqual(owner.pushAudio("gen-1", Buffer.alloc(8, 1)), { action: "BUFFERED", bufferedAudioBytes: 8 });
  assert.deepEqual(owner.holdTool("gen-1", { toolCallId: "tool-1", toolName: "reservation", arguments: { party_size: 2 } }), { action: "HELD", bufferedToolCalls: 1 });

  const release = owner.authorize("turn-1");
  assert.equal(release.action, "RELEASE");
  assert.equal(release.audioBytes, 8);
  assert.equal(release.audio.length, 1);
  assert.equal(release.toolCalls.length, 1);
  assert.equal(release.toolCalls[0].toolCallId, "tool-1");
  assert.equal(owner.snapshot().state, "IDLE");
});

test("non-terminal rejected turn requires clean provider restart and discards all effects", () => {
  const owner = new TurnAuthorizationQuarantine({ maxAudioBytes: 32 });
  owner.begin("turn-2", "gen-2");
  owner.pushAudio("gen-2", Buffer.alloc(10, 2));
  owner.holdTool("gen-2", { toolCallId: "tool-2", toolName: "write_tool", arguments: {} });

  assert.deepEqual(owner.reject("turn-2", false), {
    action: "CLEAN_RESTART_REQUIRED",
    reason: "TURN_REJECTED_UNTRUSTED_CONTEXT",
    turnId: "turn-2",
    generationId: "gen-2",
    discardedAudioBytes: 10,
    discardedToolCalls: 1,
  });
  assert.equal(owner.snapshot().state, "IDLE");
});

test("terminal rejected turn terminates provider and never releases buffered output", () => {
  const owner = new TurnAuthorizationQuarantine({ maxAudioBytes: 32 });
  owner.begin("turn-3", "gen-3");
  owner.pushAudio("gen-3", Buffer.alloc(6, 3));
  assert.equal(owner.reject("turn-3", true).action, "TERMINATE_PROVIDER");
  assert.equal(owner.snapshot().audioBytes, 0);
});

test("audio overflow fails closed without timers and requires clean restart", () => {
  const owner = new TurnAuthorizationQuarantine({ maxAudioBytes: 8 });
  owner.begin("turn-4", "gen-4");
  owner.pushAudio("gen-4", Buffer.alloc(8));
  assert.deepEqual(owner.pushAudio("gen-4", Buffer.alloc(2)), {
    action: "CLEAN_RESTART_REQUIRED",
    reason: "QUARANTINE_AUDIO_LIMIT",
    turnId: "turn-4",
    generationId: "gen-4",
    bufferedAudioBytes: 8,
  });
  assert.equal(owner.snapshot().state, "IDLE");
});

test("identity mismatch and duplicate tool ids fail closed", () => {
  const owner = new TurnAuthorizationQuarantine({ maxAudioBytes: 32 });
  owner.begin("turn-5", "gen-5");
  assert.throws(() => owner.pushAudio("other", Buffer.alloc(2)), /generation identity mismatch/);
  owner.holdTool("gen-5", { toolCallId: "tool-5", toolName: "x", arguments: {} });
  assert.throws(() => owner.holdTool("gen-5", { toolCallId: "tool-5", toolName: "x", arguments: {} }), /duplicate tool call id/);
  assert.throws(() => owner.authorize("other-turn"), /turn identity mismatch/);
});

test("default quarantine budget is bounded to about 2.7 seconds of native PCM", () => {
  assert.equal(MAX_QUARANTINE_AUDIO_BYTES, 128 * 1024);
  assert.ok(MAX_QUARANTINE_DURATION_MS >= 2_700 && MAX_QUARANTINE_DURATION_MS <= 2_750);
});
