import assert from "node:assert/strict";
import test from "node:test";
import { GeminiTelnyxMediaBridge } from "../.test-dist/gemini-telnyx-media-bridge.js";

function host({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    send(message) {
      if (fail) throw new Error("wire failed");
      sent.push(message);
    },
  };
}

function b64(bytes) { return Buffer.from(bytes).toString("base64"); }
function pcm16le(values) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer.toString("base64");
}
function start() {
  return JSON.stringify({
    event: "start",
    stream_id: "s1",
    start: { media_format: { encoding: "L16", sample_rate: 16000, channels: 1 } },
  });
}
function media(chunk, payload) {
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

test("ordered Telnyx L16 reaches only the Gemini media wire", () => {
  const gemini = host();
  const telnyx = host();
  const bridge = new GeminiTelnyxMediaBridge(gemini, telnyx);
  bridge.observeTelnyx(start());

  bridge.observeTelnyx(media(2, b64([0x00, 0x02])));
  assert.equal(gemini.sent.length, 0);
  bridge.observeTelnyx(media(1, b64([0x00, 0x01])));

  assert.equal(gemini.sent.length, 2);
  assert.equal(gemini.sent[0].realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.deepEqual([...Buffer.from(gemini.sent[0].realtimeInput.audio.data, "base64")], [0x01, 0x00]);
  assert.deepEqual([...Buffer.from(gemini.sent[1].realtimeInput.audio.data, "base64")], [0x02, 0x00]);
  assert.equal(telnyx.sent.length, 0);
  assert.equal(bridge.snapshot().inboundChunksForwarded, 2);
});

test("Gemini audio output is correlated to playback start only after Telnyx write", () => {
  const gemini = host();
  const telnyx = host();
  const bridge = new GeminiTelnyxMediaBridge(gemini, telnyx);

  const observation = bridge.observeGemini(geminiAudio([0, 3000, 6000, 9000]), "gemini-response-1");
  assert.equal(observation.emitted, 1);
  assert.deepEqual(observation.playbackEvents, [
    { type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId: "gemini-response-1" },
  ]);
  assert.equal(gemini.sent.length, 0);
  assert.equal(telnyx.sent.length, 1);
  assert.equal(telnyx.sent[0].event, "media");
  assert.equal(bridge.snapshot().outboundChunksForwarded, 1);
});

test("normal response finishes playback only when Telnyx echoes its drain mark", () => {
  const telnyx = host();
  const bridge = new GeminiTelnyxMediaBridge(host(), telnyx);
  bridge.observeGemini(geminiAudio([0, 3000, 6000, 9000]), "r-drain");
  const mark = bridge.finishPlayback("r-drain");
  assert.ok(mark);
  assert.deepEqual(telnyx.sent.at(-1), { event: "mark", mark: { name: mark } });

  const returned = bridge.observeTelnyx(JSON.stringify({
    event: "start",
    stream_id: "s1",
    start: { media_format: { encoding: "L16", sample_rate: 16000, channels: 1 } },
  }));
  assert.deepEqual(returned.playbackEvents, []);
  const done = bridge.observeTelnyx(JSON.stringify({ event: "mark", stream_id: "s1", mark: { name: mark } }));
  assert.deepEqual(done.playbackEvents, [
    { type: "ASSISTANT_AUDIO_STOPPED", kind: "NORMAL", responseId: "r-drain" },
  ]);
});

test("clear uses its own mark and returns AUDIO_CLEARED instead of AUDIO_STOPPED", () => {
  const telnyx = host();
  const bridge = new GeminiTelnyxMediaBridge(host(), telnyx);
  bridge.observeTelnyx(start());
  bridge.observeGemini(geminiAudio([0, 3000, 6000, 9000]), "greeting-1", "GREETING");
  const mark = bridge.clearPlayback("greeting-1");
  assert.ok(mark);
  assert.deepEqual(telnyx.sent.slice(-2), [
    { event: "clear" },
    { event: "mark", mark: { name: mark } },
  ]);
  const cleared = bridge.observeTelnyx(JSON.stringify({ event: "mark", stream_id: "s1", mark: { name: mark } }));
  assert.deepEqual(cleared.playbackEvents, [
    { type: "ASSISTANT_AUDIO_CLEARED", kind: "GREETING", responseId: "greeting-1" },
  ]);
});

test("uncorrelated Gemini audio fails closed before telephony output", () => {
  const telnyx = host();
  const bridge = new GeminiTelnyxMediaBridge(host(), telnyx);
  assert.throws(() => bridge.observeGemini(geminiAudio([0, 3000, 6000]), null), /requires correlated responseId/);
  assert.equal(bridge.snapshot().state, "FAILED");
  assert.equal(telnyx.sent.length, 0);
});

test("media wire failure fails the bridge closed and never changes provider", () => {
  const gemini = host({ fail: true });
  const telnyx = host();
  const bridge = new GeminiTelnyxMediaBridge(gemini, telnyx);
  bridge.observeTelnyx(start());
  assert.throws(() => bridge.observeTelnyx(media(1, b64([0x00, 0x01]))), /wire failed/);
  assert.equal(bridge.snapshot().state, "FAILED");
  assert.throws(() => bridge.observeGemini("{}", null), /bridge is failed/);
  assert.equal(telnyx.sent.length, 0);
});

test("Telnyx stop closes only the media bridge", () => {
  const bridge = new GeminiTelnyxMediaBridge(host(), host());
  bridge.observeTelnyx(start());
  const observation = bridge.observeTelnyx(JSON.stringify({ event: "stop", stream_id: "s1" }));
  assert.equal(observation.telnyx.stopped, true);
  assert.equal(bridge.snapshot().state, "STOPPED");
});
