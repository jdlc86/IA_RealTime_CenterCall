import assert from "node:assert/strict";
import test from "node:test";
import { GeminiTelnyxSessionBridge } from "../.test-dist/gemini-telnyx-session-bridge.js";

function host() {
  const sent = [];
  return {
    sent,
    send(message) { sent.push(message); },
  };
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

function geminiAudio(values, extraServerContent = {}) {
  return JSON.stringify({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm16le(values) } }],
      },
      ...extraServerContent,
    },
  });
}

function readyBridge(options = {}) {
  const gemini = host();
  const telnyx = host();
  const bridge = new GeminiTelnyxSessionBridge(gemini, telnyx, {
    model: "models/gemini-live-test",
    responseModalities: ["AUDIO"],
    manualActivityDetection: true,
  }, options);
  bridge.start();
  bridge.observeGemini(JSON.stringify({ setupComplete: {} }));
  bridge.observeTelnyx(telnyxStart());
  return { bridge, gemini, telnyx };
}

test("session-owned response identity is the only identity used for Gemini audio playback", () => {
  const { bridge, telnyx } = readyBridge();
  const observation = bridge.observeGemini(geminiAudio([0, 3000, 6000, 9000]));

  assert.deepEqual(observation.events, [
    {
      type: "ASSISTANT_RESPONSE_STARTED",
      kind: "NORMAL",
      responseId: "gemini-response-1",
      purpose: "model_turn",
    },
    { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: "gemini-response-1" },
  ]);
  assert.equal(observation.emittedAudioChunks, 1);
  assert.equal(observation.snapshot.session.activeResponseId, "gemini-response-1");
  assert.equal(bridge.activeResponseId(), "gemini-response-1");
  assert.equal(telnyx.sent.at(-1).event, "media");
});

test("DEFER session mode preserves ordered caller media without any Gemini input write", () => {
  const { bridge, gemini } = readyBridge({ inboundAudioMode: "DEFER" });
  const before = gemini.sent.length;
  const payload = Buffer.from([0x00, 0x01]).toString("base64");
  const observation = bridge.observeTelnyx(telnyxMedia(1, payload));
  assert.deepEqual(observation.telnyx.mediaPayloads, [payload]);
  assert.equal(gemini.sent.length, before);
  assert.equal(observation.snapshot.media.inboundChunksForwarded, 0);
});

test("normal generation completion drains the exact owned response through a Telnyx mark", () => {
  const { bridge, telnyx } = readyBridge();
  bridge.observeGemini(geminiAudio([0, 3000, 6000, 9000]));

  const completed = bridge.observeGemini(JSON.stringify({ serverContent: { turnComplete: true } }));
  assert.deepEqual(completed.events, [{
    type: "ASSISTANT_RESPONSE_COMPLETED",
    kind: "NORMAL",
    responseId: "gemini-response-1",
    status: "completed",
  }]);
  assert.ok(completed.drainMark);
  assert.deepEqual(telnyx.sent.at(-1), { event: "mark", mark: { name: completed.drainMark } });

  const drained = bridge.observeTelnyx(JSON.stringify({
    event: "mark",
    stream_id: "s1",
    mark: { name: completed.drainMark },
  }));
  assert.deepEqual(drained.events, [
    { type: "ASSISTANT_AUDIO_STOPPED", kind: "NORMAL", responseId: "gemini-response-1" },
  ]);
});

test("audio and turnComplete in one Gemini message preserve start-audio-complete causal order", () => {
  const { bridge, telnyx } = readyBridge();
  const observation = bridge.observeGemini(geminiAudio(
    [0, 3000, 6000, 9000],
    { turnComplete: true },
  ));

  assert.deepEqual(observation.events, [
    {
      type: "ASSISTANT_RESPONSE_STARTED",
      kind: "NORMAL",
      responseId: "gemini-response-1",
      purpose: "model_turn",
    },
    { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: "gemini-response-1" },
    {
      type: "ASSISTANT_RESPONSE_COMPLETED",
      kind: "NORMAL",
      responseId: "gemini-response-1",
      status: "completed",
    },
  ]);
  assert.ok(observation.drainMark);
  assert.deepEqual(telnyx.sent.slice(-2).map((message) => message.event), ["media", "mark"]);
});

test("provider interruption completes lifecycle but never clears Telnyx playback autonomously", () => {
  const { bridge, telnyx } = readyBridge();
  bridge.observeGemini(geminiAudio([0, 3000, 6000, 9000]));
  const before = telnyx.sent.length;

  const interrupted = bridge.observeGemini(JSON.stringify({ serverContent: { interrupted: true } }));
  assert.deepEqual(interrupted.events, [{
    type: "ASSISTANT_RESPONSE_COMPLETED",
    kind: "NORMAL",
    responseId: "gemini-response-1",
    status: "interrupted",
  }]);
  assert.equal(interrupted.drainMark, null);
  assert.equal(telnyx.sent.length, before);
});

test("authorized playback clear requires exact active response identity and Telnyx mark evidence", () => {
  const { bridge, telnyx } = readyBridge();
  bridge.observeGemini(geminiAudio([0, 3000, 6000, 9000]));
  const before = telnyx.sent.length;

  assert.throws(
    () => bridge.clearActivePlayback("gemini-response-999"),
    /requires active owned response/,
  );
  assert.equal(telnyx.sent.length, before);

  const clearMark = bridge.clearActivePlayback("gemini-response-1");
  assert.ok(clearMark);
  assert.deepEqual(telnyx.sent.slice(-2), [
    { event: "clear" },
    { event: "mark", mark: { name: clearMark } },
  ]);

  const cleared = bridge.observeTelnyx(JSON.stringify({
    event: "mark",
    stream_id: "s1",
    mark: { name: clearMark },
  }));
  assert.deepEqual(cleared.events, [
    { type: "ASSISTANT_AUDIO_CLEARED", kind: "NORMAL", responseId: "gemini-response-1" },
  ]);
});

test("playback clear cannot use stale response identity after Gemini lifecycle release", () => {
  const { bridge, telnyx } = readyBridge();
  bridge.observeGemini(geminiAudio([0, 3000, 6000, 9000]));
  bridge.observeGemini(JSON.stringify({ serverContent: { interrupted: true } }));
  const before = telnyx.sent.length;

  assert.equal(bridge.activeResponseId(), null);
  assert.throws(
    () => bridge.clearActivePlayback("gemini-response-1"),
    /requires active owned response/,
  );
  assert.equal(telnyx.sent.length, before);
});

test("input transcription remains evidence-only through the composed edge", () => {
  const { bridge } = readyBridge();
  const observation = bridge.observeGemini(JSON.stringify({
    serverContent: { inputTranscription: { text: "quiero una mesa" } },
  }));

  assert.deepEqual(observation.events, []);
  assert.deepEqual(observation.transcriptionChunks, [{ direction: "INPUT", text: "quiero una mesa" }]);
});
