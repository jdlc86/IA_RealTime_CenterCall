import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createAuthoritativeCallerTranscriptionPort } from "../.test-dist/authoritative-caller-transcription-port.js";
import { GeminiAuthorizedBargeInCommitAdapter } from "../.test-dist/gemini-authorized-barge-in-commit-adapter.js";
import { GeminiAuthorizedBargeInEffectRuntime } from "../.test-dist/gemini-authorized-barge-in-effect-runtime.js";
import { GeminiDeferredBargeInCandidateOwner } from "../.test-dist/gemini-deferred-barge-in-candidate-owner.js";
import { GeminiTelnyxSessionBridge } from "../.test-dist/gemini-telnyx-session-bridge.js";

const source = readFileSync(new URL("./gemini-authorized-barge-in-effect-runtime.ts", import.meta.url), "utf8");

function host() {
  const sent = [];
  return { sent, send(message) { sent.push(message); } };
}

function pcm16le(values) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer.toString("base64");
}

function telnyxStart() {
  return JSON.stringify({
    event: "start",
    stream_id: "s1",
    start: { media_format: { encoding: "L16", sample_rate: 16000, channels: 1 } },
  });
}

function geminiAudio(values) {
  return JSON.stringify({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm16le(values) } }],
      },
    },
  });
}

function interruptingSetup() {
  return {
    model: "models/gemini-live-test",
    responseModalities: ["AUDIO"],
    manualActivityDetection: true,
    manualActivityHandling: "START_OF_ACTIVITY_INTERRUPTS",
  };
}

async function confirmedCandidate() {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  const started = owner.beginCandidate();
  owner.bufferTelnyxMedia(Buffer.from([0x00, 0x01]).toString("base64"));
  const port = createAuthoritativeCallerTranscriptionPort({
    async transcribe(input) {
      return { itemId: input.itemId, transcript: "espera un momento" };
    },
  });
  owner.completeCandidate(await port.transcribe(owner.transcriptionRequest()));
  return owner.confirmInterruption(started.itemId);
}

function readyRuntime() {
  const gemini = host();
  const telnyx = host();
  const setup = interruptingSetup();
  const bridge = new GeminiTelnyxSessionBridge(gemini, telnyx, setup);
  bridge.start();
  bridge.observeGemini(JSON.stringify({ setupComplete: {} }));
  bridge.observeTelnyx(telnyxStart());
  bridge.observeGemini(geminiAudio([0, 3000, 6000, 9000]));
  const commit = new GeminiAuthorizedBargeInCommitAdapter(gemini, setup);
  const runtime = new GeminiAuthorizedBargeInEffectRuntime(commit, bridge);
  return { runtime, bridge, gemini, telnyx };
}

test("effect runtime cannot arm from shape-compatible or provider evidence", () => {
  const { runtime, gemini, telnyx } = readyRuntime();
  const geminiBefore = gemini.sent.length;
  const telnyxBefore = telnyx.sent.length;

  assert.throws(
    () => runtime.arm({
      itemId: "gemini-candidate-1",
      transcript: "hola",
      mediaPayloads: ["AAE="],
    }),
    /not semantically authorized/,
  );
  assert.equal(gemini.sent.length, geminiBefore);
  assert.equal(telnyx.sent.length, telnyxBefore);
  assert.doesNotMatch(source, /CALLER_TRANSCRIPT_COMPLETED|CALLER_SPEECH_STARTED|interrupted\s*===/);
  assert.doesNotMatch(source, /setTimeout\s*\(|\bsleep\s*\(/);
});

test("authorized effect order is arm then cancel_response then clear_playback", async () => {
  const { runtime, bridge, gemini, telnyx } = readyRuntime();
  const candidate = await confirmedCandidate();
  const geminiBefore = gemini.sent.length;
  const telnyxBefore = telnyx.sent.length;

  assert.deepEqual(runtime.arm(candidate), {
    state: "ACTIVE",
    armedItemId: candidate.itemId,
    cancelledResponseId: null,
    committedInterruptions: 0,
    clearedPlaybacks: 0,
  });
  assert.throws(() => runtime.clearPlayback(), /requires prior authorized cancel_response/);
  assert.equal(gemini.sent.length, geminiBefore);
  assert.equal(telnyx.sent.length, telnyxBefore);

  assert.deepEqual(runtime.cancelResponse("gemini-response-1"), {
    state: "ACTIVE",
    armedItemId: null,
    cancelledResponseId: "gemini-response-1",
    committedInterruptions: 1,
    clearedPlaybacks: 0,
  });
  assert.deepEqual(gemini.sent.slice(geminiBefore).map((message) => (
    message.realtimeInput?.activityStart ? "start"
      : message.realtimeInput?.audio ? "audio"
        : message.realtimeInput?.activityEnd ? "end"
          : "other"
  )), ["start", "audio", "end"]);
  assert.equal(telnyx.sent.length, telnyxBefore, "cancel_response must not clear Telnyx playback itself");

  const cleared = runtime.clearPlayback();
  assert.ok(cleared.mark);
  assert.deepEqual(cleared.snapshot, {
    state: "ACTIVE",
    armedItemId: null,
    cancelledResponseId: null,
    committedInterruptions: 1,
    clearedPlaybacks: 1,
  });
  assert.deepEqual(telnyx.sent.slice(telnyxBefore), [
    { event: "clear" },
    { event: "mark", mark: { name: cleared.mark } },
  ]);

  const evidence = bridge.observeTelnyx(JSON.stringify({
    event: "mark",
    stream_id: "s1",
    mark: { name: cleared.mark },
  }));
  assert.deepEqual(evidence.events, [
    { type: "ASSISTANT_AUDIO_CLEARED", kind: "NORMAL", responseId: "gemini-response-1" },
  ]);
});

test("authorized barge-in survives provider response release while the same Telnyx playback is active", async () => {
  const { runtime, bridge, gemini, telnyx } = readyRuntime();
  runtime.arm(await confirmedCandidate());
  const interrupted = bridge.observeGemini(JSON.stringify({ serverContent: { interrupted: true } }));
  assert.equal(interrupted.events[0]?.type, "ASSISTANT_RESPONSE_COMPLETED");
  assert.equal(bridge.activeResponseId(), null);
  assert.equal(bridge.activePlaybackResponseId(), "gemini-response-1");

  const geminiBefore = gemini.sent.length;
  const telnyxBefore = telnyx.sent.length;
  const cancelled = runtime.cancelResponse("gemini-response-1");
  assert.equal(cancelled.cancelledResponseId, "gemini-response-1");
  assert.equal(cancelled.committedInterruptions, 1);
  assert.deepEqual(gemini.sent.slice(geminiBefore).map((message) => (
    message.realtimeInput?.activityStart ? "start"
      : message.realtimeInput?.audio ? "audio"
        : message.realtimeInput?.activityEnd ? "end"
          : "other"
  )), ["start", "audio", "end"]);

  const cleared = runtime.clearPlayback();
  assert.ok(cleared.mark);
  assert.deepEqual(telnyx.sent.slice(telnyxBefore), [
    { event: "clear" },
    { event: "mark", mark: { name: cleared.mark } },
  ]);
});

test("different active response fails closed even if an older playback identity could match", async () => {
  const { runtime, bridge } = readyRuntime();
  runtime.arm(await confirmedCandidate());
  bridge.observeGemini(JSON.stringify({ serverContent: { interrupted: true } }));
  bridge.observeGemini(JSON.stringify({ toolCall: { functionCalls: [{ id: "fc-new", name: "search" }] } }));
  assert.equal(bridge.activeResponseId(), "gemini-response-2");
  assert.equal(bridge.activePlaybackResponseId(), "gemini-response-1");
  assert.throws(
    () => runtime.cancelResponse("gemini-response-1"),
    /identity mismatch/,
  );
  assert.equal(runtime.snapshot().state, "FAILED");
});

test("cancel_response must match current response or playback ownership", async () => {
  const { runtime, gemini, telnyx } = readyRuntime();
  runtime.arm(await confirmedCandidate());
  const geminiBefore = gemini.sent.length;
  const telnyxBefore = telnyx.sent.length;

  assert.throws(
    () => runtime.cancelResponse("gemini-response-999"),
    /identity mismatch/,
  );
  assert.deepEqual(runtime.snapshot(), {
    state: "FAILED",
    armedItemId: null,
    cancelledResponseId: null,
    committedInterruptions: 0,
    clearedPlaybacks: 0,
  });
  assert.equal(gemini.sent.length, geminiBefore);
  assert.equal(telnyx.sent.length, telnyxBefore);
  assert.throws(() => runtime.cancelResponse("gemini-response-1"), /runtime is failed/);
});

test("one in-flight authorized interruption cannot be re-armed or double-cancelled", async () => {
  const { runtime } = readyRuntime();
  const first = await confirmedCandidate();
  runtime.arm(first);
  assert.throws(() => runtime.arm({}), /already owns an in-flight interruption/);
  runtime.cancelResponse("gemini-response-1");
  assert.throws(() => runtime.arm({}), /already owns an in-flight interruption/);
  assert.throws(() => runtime.cancelResponse("gemini-response-1"), /requires an armed authorized candidate/);
});
