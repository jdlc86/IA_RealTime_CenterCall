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

test("governed post-tool response drops provider audio before and after binding then releases cleanly", () => {
  const playback = new BoundPlaybackGate(64 * 1024);
  const effects = [];
  const sink = createGeminiPostToolControlSink((command) => {
    if (command.type === "PLAYBACK_BINDING") {
      effects.push({ type: "binding", chunks: playback.bind(command.responseId, command.kind) });
    }
    if (command.type === "PLAYBACK_DRAIN") {
      effects.push({ type: "drain", mark: playback.finish(command.responseId) });
    }
    return true;
  });

  sink(toolResult("restaurant_reservation_create", {
    ok: true,
    status: "MISSING_INFORMATION",
    missing: ["starts_at", "party_size"],
  }));

  // Gemini Live may emit automatic audio before the CP binding traverses the sideband.
  playback.queue(Buffer.from([1, 0, 2, 0]));
  sink({ type: "PLAYBACK_BINDING", responseId: "gemini-response-1", kind: "NORMAL" });
  assert.equal(effects[0].type, "binding");
  assert.deepEqual(effects[0].chunks, []);
  assert.equal(playback.snapshot().pendingBytes, 0);

  // Streaming chunks after the binding are suppressed as well.
  playback.queue(Buffer.from([3, 0, 4, 0]));
  assert.deepEqual(playback.flush(), []);
  sink({ type: "PLAYBACK_DRAIN", responseId: "gemini-response-1" });
  assert.deepEqual(effects[1], { type: "drain", mark: null });
  assert.equal(playback.activeResponseId(), null);
  assert.equal(playback.snapshot().binding, null);

  // A later ordinary Gemini response keeps the original media path.
  sink(toolResult("restaurant_business_info", { ok: true, status: "BUSINESS_INFO_READY" }));
  playback.queue(Buffer.from([5, 0, 6, 0]));
  sink({ type: "PLAYBACK_BINDING", responseId: "gemini-response-2", kind: "NORMAL" });
  assert.equal(effects[2].chunks.length, 1);
  assert.deepEqual([...effects[2].chunks[0].pcm], [5, 0, 6, 0]);
});

test("governed speech clears an armed suppression that never received a provider binding", () => {
  const forwarded = [];
  const sink = createGeminiPostToolControlSink((command) => { forwarded.push(command.type); return true; });
  sink(toolResult("restaurant_reservation_create", {
    ok: true,
    status: "TIME_EVIDENCE_REQUIRED",
  }));
  sink({ type: "GOVERNED_SPEECH", responseId: "governed-1", text: "¿A qué hora?" });
  sink({ type: "PLAYBACK_BINDING", responseId: "later-normal", kind: "NORMAL" });
  assert.deepEqual(forwarded, ["TOOL_RESULT", "GOVERNED_SPEECH", "PLAYBACK_BINDING"]);
});
