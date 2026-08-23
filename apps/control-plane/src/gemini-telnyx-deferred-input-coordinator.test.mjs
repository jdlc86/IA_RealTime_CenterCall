import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createAuthoritativeCallerTranscriptionPort } from "../.test-dist/authoritative-caller-transcription-port.js";
import { GeminiTelnyxDeferredInputCoordinator } from "../.test-dist/gemini-telnyx-deferred-input-coordinator.js";

const source = readFileSync(new URL("./gemini-telnyx-deferred-input-coordinator.ts", import.meta.url), "utf8");

function host() {
  const sent = [];
  return { sent, send(message) { sent.push(message); } };
}

function pcm16be(sample, count) {
  const buffer = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) buffer.writeInt16BE(sample, index * 2);
  return buffer.toString("base64");
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

function telnyxMedia(chunk, payload) {
  return JSON.stringify({
    event: "media",
    stream_id: "s1",
    media: { track: "inbound", chunk: String(chunk), payload },
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

function setup() {
  return {
    model: "models/gemini-live-test",
    responseModalities: ["AUDIO"],
    manualActivityDetection: true,
    manualActivityHandling: "START_OF_ACTIVITY_INTERRUPTS",
  };
}

function vadConfig() {
  return {
    startRms: 0.10,
    stopRms: 0.04,
    minSpeechMs: 20,
    minSilenceMs: 20,
  };
}

function readyCoordinator() {
  const gemini = host();
  const telnyx = host();
  const sttRequests = [];
  const transcription = createAuthoritativeCallerTranscriptionPort({
    async transcribe(request) {
      sttRequests.push(request);
      return { itemId: request.itemId, transcript: `transcript ${request.itemId}` };
    },
  });
  const coordinator = new GeminiTelnyxDeferredInputCoordinator(
    gemini,
    telnyx,
    setup(),
    transcription,
    vadConfig(),
  );
  coordinator.start();
  coordinator.observeGemini(JSON.stringify({ setupComplete: {} }));
  return { coordinator, gemini, telnyx, sttRequests };
}

async function startMedia(coordinator) {
  await coordinator.observeTelnyx(telnyxStart());
}

test("normal caller speech is STT-completed then committed once while session is idle", async () => {
  const { coordinator, gemini, sttRequests } = readyCoordinator();
  await startMedia(coordinator);
  const before = gemini.sent.length;
  const loud = pcm16be(9000, 320);
  const quiet = pcm16be(0, 320);

  const started = await coordinator.observeTelnyx(telnyxMedia(1, loud));
  assert.equal(started.events[0]?.type, "CALLER_SPEECH_STARTED");
  assert.equal(started.snapshot.playbackResponseIdAtSpeechStart, null);

  const completed = await coordinator.observeTelnyx(telnyxMedia(2, quiet));
  assert.deepEqual(completed.events.slice(-2).map((event) => event.type), [
    "CALLER_SPEECH_STOPPED",
    "CALLER_TRANSCRIPT_COMPLETED",
  ]);
  assert.equal(sttRequests.length, 1);
  assert.deepEqual(sttRequests[0].audio.payloads, [loud, quiet]);
  assert.deepEqual(gemini.sent.slice(before).map((message) => (
    message.realtimeInput?.activityStart ? "start"
      : message.realtimeInput?.audio ? "audio"
        : message.realtimeInput?.activityEnd ? "end"
          : "other"
  )), ["start", "audio", "audio", "end"]);
  assert.equal(completed.snapshot.activeCallerItemId, null);
  assert.equal(completed.snapshot.awaitingBargeInDecision, false);
});

test("speech that begins during playback is retained and IGNORE has no Gemini or Telnyx side effect", async () => {
  const { coordinator, gemini, telnyx } = readyCoordinator();
  await startMedia(coordinator);
  coordinator.observeGemini(geminiAudio([0, 3000, 6000, 9000]));
  const geminiBeforeSpeech = gemini.sent.length;
  const telnyxBeforeSpeech = telnyx.sent.length;

  await coordinator.observeTelnyx(telnyxMedia(1, pcm16be(9000, 160)));
  const started = await coordinator.observeTelnyx(telnyxMedia(2, pcm16be(9000, 160)));
  assert.equal(started.snapshot.playbackResponseIdAtSpeechStart, "gemini-response-1");
  const completed = await coordinator.observeTelnyx(telnyxMedia(3, pcm16be(0, 320)));
  assert.equal(completed.snapshot.awaitingBargeInDecision, true);
  assert.equal(gemini.sent.length, geminiBeforeSpeech, "candidate audio must remain deferred before decision");
  assert.equal(telnyx.sent.length, telnyxBeforeSpeech, "playback must remain untouched before decision");

  coordinator.resolveBargeIn("gemini-candidate-1", "IGNORE");
  assert.equal(gemini.sent.length, geminiBeforeSpeech);
  assert.equal(telnyx.sent.length, telnyxBeforeSpeech);
  assert.equal(coordinator.snapshot().activeCallerItemId, null);
  assert.equal(coordinator.snapshot().awaitingBargeInDecision, false);
});

test("playback identity is captured from first acoustic evidence even if provider lifecycle releases before speech boundary", async () => {
  const { coordinator, gemini, telnyx } = readyCoordinator();
  await startMedia(coordinator);
  coordinator.observeGemini(geminiAudio([0, 3000, 6000, 9000]));

  await coordinator.observeTelnyx(telnyxMedia(1, pcm16be(9000, 160)));
  coordinator.observeGemini(JSON.stringify({ serverContent: { interrupted: true } }));
  const started = await coordinator.observeTelnyx(telnyxMedia(2, pcm16be(9000, 160)));
  assert.equal(started.snapshot.session.session.activeResponseId, null);
  assert.equal(started.snapshot.playbackResponseIdAtSpeechStart, "gemini-response-1");
  assert.equal(started.snapshot.session.media.outboundChunksForwarded, 1);

  await coordinator.observeTelnyx(telnyxMedia(3, pcm16be(0, 320)));
  const geminiBeforeDecision = gemini.sent.length;
  const telnyxBeforeDecision = telnyx.sent.length;
  const resolved = coordinator.resolveBargeIn("gemini-candidate-1", "INTERRUPT");

  assert.deepEqual(gemini.sent.slice(geminiBeforeDecision).map((message) => (
    message.realtimeInput?.activityStart ? "start"
      : message.realtimeInput?.audio ? "audio"
        : message.realtimeInput?.activityEnd ? "end"
          : "other"
  )), ["start", "audio", "audio", "audio", "end"]);
  assert.deepEqual(telnyx.sent.slice(telnyxBeforeDecision).map((message) => message.event), ["clear", "mark"]);
  assert.equal(resolved.activeCallerItemId, null);
});

test("if original playback drains before INTERRUPT resolution, caller audio is released as a normal turn", async () => {
  const { coordinator, gemini, telnyx } = readyCoordinator();
  await startMedia(coordinator);
  coordinator.observeGemini(geminiAudio([0, 3000, 6000, 9000]));
  await coordinator.observeTelnyx(telnyxMedia(1, pcm16be(9000, 320)));
  await coordinator.observeTelnyx(telnyxMedia(2, pcm16be(0, 320)));
  assert.equal(coordinator.snapshot().awaitingBargeInDecision, true);

  const completed = coordinator.observeGemini(JSON.stringify({ serverContent: { turnComplete: true } }));
  assert.ok(completed.drainMark);
  await coordinator.observeTelnyx(JSON.stringify({
    event: "mark",
    stream_id: "s1",
    mark: { name: completed.drainMark },
  }));
  assert.equal(coordinator.snapshot().session.session.activeResponseId, null);

  const geminiBefore = gemini.sent.length;
  const telnyxBefore = telnyx.sent.length;
  coordinator.resolveBargeIn("gemini-candidate-1", "INTERRUPT");
  assert.deepEqual(gemini.sent.slice(geminiBefore).map((message) => (
    message.realtimeInput?.activityStart ? "start"
      : message.realtimeInput?.audio ? "audio"
        : message.realtimeInput?.activityEnd ? "end"
          : "other"
  )), ["start", "audio", "audio", "end"]);
  assert.equal(telnyx.sent.length, telnyxBefore, "already-drained playback must not be cleared again");
});

test("a newer active response supersedes the original playback target and fails closed", async () => {
  const { coordinator } = readyCoordinator();
  await startMedia(coordinator);
  coordinator.observeGemini(geminiAudio([0, 3000, 6000, 9000]));
  await coordinator.observeTelnyx(telnyxMedia(1, pcm16be(9000, 320)));
  await coordinator.observeTelnyx(telnyxMedia(2, pcm16be(0, 320)));
  coordinator.observeGemini(JSON.stringify({ serverContent: { interrupted: true } }));
  coordinator.observeGemini(JSON.stringify({ toolCall: { functionCalls: [{ id: "fc-new", name: "search" }] } }));
  assert.throws(
    () => coordinator.resolveBargeIn("gemini-candidate-1", "INTERRUPT"),
    /superseded by active response/,
  );
});

test("deferred input coordinator has one media ingress and no wall-clock routing heuristic", () => {
  assert.match(source, /inboundAudioMode:\s*"DEFER"/);
  assert.doesNotMatch(source, /setTimeout\s*\(|setInterval\s*\(|Date\.now\s*\(|\bsleep\s*\(/);
  assert.doesNotMatch(source, /inputTranscription|generationComplete/);
});
