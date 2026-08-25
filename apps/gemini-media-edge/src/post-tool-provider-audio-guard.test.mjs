import test from "node:test";
import assert from "node:assert/strict";
import { BoundPlaybackGate } from "./runtime-core.mjs";
import {
  createGeminiPostToolControlSink,
  installGeminiPostToolPlaybackSuppression,
  shouldSuppressGeminiPostToolProviderAudio,
} from "./post-tool-provider-audio-guard.mjs";

installGeminiPostToolPlaybackSuppression(BoundPlaybackGate);

function toolResult(toolName, output) {
  return { type: "TOOL_RESULT", callId: "fc_real_provider_id", toolName, output };
}

test("post-tool guard mirrors governed reservation collection and terminal outcomes", () => {
  assert.equal(shouldSuppressGeminiPostToolProviderAudio(toolResult("restaurant_reservation_create", {
    ok: true,
    status: "MISSING_INFORMATION",
    missing: ["starts_at", "party_size"],
  })), true);
  assert.equal(shouldSuppressGeminiPostToolProviderAudio(toolResult("restaurant_reservation_create", {
    ok: true,
    stage: "BOOKED",
  })), true);
  assert.equal(shouldSuppressGeminiPostToolProviderAudio(toolResult("restaurant_reservation_create", {
    ok: true,
    stage: "BOOKED",
    ask_marketing_consent: true,
  })), false);
  assert.equal(shouldSuppressGeminiPostToolProviderAudio(toolResult("restaurant_reservation_create", {
    ok: true,
    status: "MISSING_INFORMATION",
    missing: [],
  })), false);
  assert.equal(shouldSuppressGeminiPostToolProviderAudio(toolResult("restaurant_business_info", {
    ok: true,
    status: "BUSINESS_INFO_READY",
  })), false);
  assert.equal(shouldSuppressGeminiPostToolProviderAudio(toolResult("restaurant_business_info", {
    ok: true,
    status: "FOUND",
  })), true);
});

test("governed post-tool speech waits for the silent Gemini response drain before taking playback", () => {
  const playback = new BoundPlaybackGate(64 * 1024);
  const effects = [];
  const sink = createGeminiPostToolControlSink((command) => {
    if (command.type === "TOOL_RESULT") effects.push({ type: "tool_result" });
    if (command.type === "PLAYBACK_BINDING") {
      effects.push({ type: "binding", chunks: playback.bind(command.responseId, command.kind) });
    }
    if (command.type === "PLAYBACK_DRAIN") {
      effects.push({ type: "drain", mark: playback.finish(command.responseId) });
    }
    if (command.type === "GOVERNED_SPEECH") {
      playback.assertIdle();
      effects.push({ type: "governed", responseId: command.responseId });
    }
    return true;
  }, { onArmed: () => playback.suppressProviderAudio() });

  sink(toolResult("restaurant_reservation_create", {
    ok: true,
    status: "MISSING_INFORMATION",
    missing: ["starts_at", "party_size"],
  }));

  // Gemini Live may emit automatic audio before the CP binding traverses the sideband.
  playback.queue(Buffer.from([1, 0, 2, 0]));
  sink({ type: "PLAYBACK_BINDING", responseId: "gemini-response-1", kind: "NORMAL" });
  assert.equal(effects[1].type, "binding");
  assert.deepEqual(effects[1].chunks, []);
  assert.equal(playback.snapshot().pendingBytes, 0);
  assert.equal(playback.snapshot().binding, "gemini-response-1");

  // Streaming chunks after the binding are suppressed as well.
  playback.queue(Buffer.from([3, 0, 4, 0]));
  assert.deepEqual(playback.flush(), []);

  // This is the production ordering: governed speech arrives while the provider
  // response still owns an empty binding. It must be deferred, not failed.
  sink({ type: "GOVERNED_SPEECH", responseId: "governed-1", text: "¿Para qué día y hora?" });
  assert.equal(effects.some((effect) => effect.type === "governed"), false);
  assert.equal(playback.snapshot().binding, "gemini-response-1");

  // The real provider completion produces PLAYBACK_DRAIN. Only after that exact
  // response releases physical ownership may governed playback begin.
  sink({ type: "PLAYBACK_DRAIN", responseId: "gemini-response-1" });
  assert.deepEqual(effects.slice(2), [
    { type: "drain", mark: null },
    { type: "governed", responseId: "governed-1" },
  ]);
  assert.equal(playback.activeResponseId(), null);
  assert.equal(playback.snapshot().binding, null);

  // A later ordinary Gemini response keeps the original media path.
  sink(toolResult("restaurant_business_info", { ok: true, status: "BUSINESS_INFO_READY" }));
  playback.queue(Buffer.from([5, 0, 6, 0]));
  sink({ type: "PLAYBACK_BINDING", responseId: "gemini-response-2", kind: "NORMAL" });
  const ordinaryBinding = effects.findLast((effect) => effect.type === "binding");
  assert.equal(ordinaryBinding.chunks.length, 1);
  assert.deepEqual([...ordinaryBinding.chunks[0].pcm], [5, 0, 6, 0]);
});

test("governed speech may arrive before the provider binding and still waits for real completion", () => {
  const playback = new BoundPlaybackGate(64 * 1024);
  const forwarded = [];
  const sink = createGeminiPostToolControlSink((command) => {
    forwarded.push(command.type);
    if (command.type === "PLAYBACK_BINDING") playback.bind(command.responseId, command.kind);
    if (command.type === "PLAYBACK_DRAIN") playback.finish(command.responseId);
    if (command.type === "GOVERNED_SPEECH") playback.assertIdle();
    return true;
  }, { onArmed: () => playback.suppressProviderAudio() });

  sink(toolResult("restaurant_reservation_create", {
    ok: true,
    status: "TIME_EVIDENCE_REQUIRED",
  }));
  sink({ type: "GOVERNED_SPEECH", responseId: "governed-early", text: "¿A qué hora?" });
  assert.deepEqual(forwarded, ["TOOL_RESULT"]);

  playback.queue(Buffer.from([1, 0]));
  sink({ type: "PLAYBACK_BINDING", responseId: "gemini-response-early", kind: "NORMAL" });
  playback.queue(Buffer.from([2, 0]));
  sink({ type: "PLAYBACK_DRAIN", responseId: "gemini-response-early" });
  assert.deepEqual(forwarded, ["TOOL_RESULT", "PLAYBACK_BINDING", "PLAYBACK_DRAIN", "GOVERNED_SPEECH"]);
});

test("governed post-tool drain identity mismatch fails closed", () => {
  const playback = new BoundPlaybackGate(64 * 1024);
  const sink = createGeminiPostToolControlSink((command) => {
    if (command.type === "PLAYBACK_BINDING") playback.bind(command.responseId, command.kind);
    if (command.type === "PLAYBACK_DRAIN") playback.finish(command.responseId);
    return true;
  }, { onArmed: () => playback.suppressProviderAudio() });

  sink(toolResult("restaurant_reservation_create", {
    ok: true,
    status: "MISSING_INFORMATION",
    missing: ["starts_at"],
  }));
  sink({ type: "PLAYBACK_BINDING", responseId: "gemini-response-1", kind: "NORMAL" });
  assert.throws(
    () => sink({ type: "PLAYBACK_DRAIN", responseId: "gemini-response-other" }),
    /drain identity mismatch/,
  );
});

test("post-tool suppression captures the provider binding that already owns playback", () => {
  const playback = new BoundPlaybackGate(64 * 1024);
  playback.bind("gemini-response-active", "NORMAL");
  const effects = [];
  const sink = createGeminiPostToolControlSink((command) => {
    effects.push(command.type);
    if (command.type === "PLAYBACK_DRAIN") playback.finish(command.responseId);
    if (command.type === "GOVERNED_SPEECH") playback.assertIdle();
    return true;
  }, { onArmed: () => playback.suppressProviderAudio() });

  sink(toolResult("restaurant_reservation_create", {
    ok: true,
    status: "MISSING_INFORMATION",
    missing: ["starts_at", "party_size"],
  }));
  playback.queue(Buffer.from([1, 0, 2, 0]));
  assert.deepEqual(playback.flush(), []);

  sink({ type: "GOVERNED_SPEECH", responseId: "gemini-response-active", text: "¿Para qué día y hora?" });
  assert.deepEqual(effects, ["TOOL_RESULT"]);
  sink({ type: "PLAYBACK_DRAIN", responseId: "gemini-response-active" });
  assert.deepEqual(effects, ["TOOL_RESULT", "PLAYBACK_DRAIN", "GOVERNED_SPEECH"]);
  assert.equal(playback.activeResponseId(), null);
});
