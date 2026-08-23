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

test("Gemini audio output is resampled and emitted only to Telnyx", () => {
  const gemini = host();
  const telnyx = host();
  const bridge = new GeminiTelnyxMediaBridge(gemini, telnyx);

  const emitted = bridge.observeGemini(JSON.stringify({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm16le([0, 3000, 6000, 9000]) } }],
      },
    },
  }));

  assert.equal(emitted, 1);
  assert.equal(gemini.sent.length, 0);
  assert.equal(telnyx.sent.length, 1);
  assert.equal(telnyx.sent[0].event, "media");
  assert.equal(bridge.snapshot().outboundChunksForwarded, 1);
});

test("clear and mark remain Telnyx playback commands, not Gemini conversation commands", () => {
  const gemini = host();
  const telnyx = host();
  const bridge = new GeminiTelnyxMediaBridge(gemini, telnyx);
  bridge.clearPlayback();
  bridge.sendPlaybackMark("gemini-response-4");
  assert.deepEqual(telnyx.sent, [
    { event: "clear" },
    { event: "mark", mark: { name: "gemini-response-4" } },
  ]);
  assert.deepEqual(gemini.sent, []);
});

test("media wire failure fails the bridge closed and never changes provider", () => {
  const gemini = host({ fail: true });
  const telnyx = host();
  const bridge = new GeminiTelnyxMediaBridge(gemini, telnyx);
  bridge.observeTelnyx(start());
  assert.throws(() => bridge.observeTelnyx(media(1, b64([0x00, 0x01]))), /wire failed/);
  assert.equal(bridge.snapshot().state, "FAILED");
  assert.throws(() => bridge.observeGemini("{}"), /bridge is failed/);
  assert.equal(telnyx.sent.length, 0);
});

test("Telnyx stop closes only the media bridge", () => {
  const bridge = new GeminiTelnyxMediaBridge(host(), host());
  bridge.observeTelnyx(start());
  const observation = bridge.observeTelnyx(JSON.stringify({ event: "stop", stream_id: "s1" }));
  assert.equal(observation.stopped, true);
  assert.equal(bridge.snapshot().state, "STOPPED");
});
