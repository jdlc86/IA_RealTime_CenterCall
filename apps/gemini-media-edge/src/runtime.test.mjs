import test from "node:test";
import assert from "node:assert/strict";
import { BoundPlaybackGate, commitDeferredCallerTurn, Pcm16Resampler24To16, swapPcm16Endianness } from "./runtime.mjs";

class FakeSocket {
  constructor() { this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
}

test("PCM16 endian conversion is deterministic and reversible", () => {
  const source = Buffer.from([0x12, 0x34, 0xab, 0xcd]);
  const swapped = swapPcm16Endianness(source);
  assert.deepEqual([...swapped], [0x34, 0x12, 0xcd, 0xab]);
  assert.deepEqual([...swapPcm16Endianness(swapped)], [...source]);
});

test("PCM16 endian conversion rejects incomplete samples", () => {
  assert.throws(() => swapPcm16Endianness(Buffer.from([1])), /complete 16-bit samples/);
});

test("24 to 16 kHz resampler is stateful across provider chunk boundaries", () => {
  const samples = Array.from({ length: 480 }, (_, i) => Math.round(Math.sin(i / 12) * 12000));
  const encode = (values) => { const b = Buffer.alloc(values.length * 2); values.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; };
  const whole = new Pcm16Resampler24To16().push(encode(samples));
  const splitResampler = new Pcm16Resampler24To16();
  const first = splitResampler.push(encode(samples.slice(0, 173)));
  const second = splitResampler.push(encode(samples.slice(173)));
  const split = Buffer.concat([first, second]);
  assert.ok(whole.length > 0);
  assert.ok(split.length > 0);
  assert.ok(Math.abs(whole.length - split.length) <= 2);
});

test("authorized deferred caller turn emits only activityStart, audio, activityEnd", () => {
  const socket = new FakeSocket();
  const l16 = Buffer.from([0x12, 0x34, 0xab, 0xcd]).toString("base64");
  commitDeferredCallerTurn(socket, { itemId: "gemini-candidate-1", mediaPayloads: [l16] }, () => {});
  assert.deepEqual(socket.sent, [
    { realtimeInput: { activityStart: {} } },
    { realtimeInput: { audio: { data: Buffer.from([0x34, 0x12, 0xcd, 0xab]).toString("base64"), mimeType: "audio/pcm;rate=16000" } } },
    { realtimeInput: { activityEnd: {} } },
  ]);
  assert.equal(JSON.stringify(socket.sent).includes("text"), false);
});

test("Gemini playback is retained until the control-plane response binding arrives", () => {
  const gate = new BoundPlaybackGate(64 * 1024);
  const pcm = Buffer.from([0x01, 0x00, 0x02, 0x00]);
  gate.queue(pcm);
  assert.deepEqual(gate.flush(), []);
  assert.equal(gate.snapshot().pendingChunks, 1);
  const released = gate.bind("gemini-response-1");
  assert.equal(released.length, 1);
  assert.equal(released[0].responseId, "gemini-response-1");
  assert.deepEqual(released[0].pcm, pcm);
  assert.equal(gate.snapshot().pendingChunks, 0);
});

test("Gemini playback binding is immutable while a response owns playback", () => {
  const gate = new BoundPlaybackGate(64 * 1024);
  gate.bind("gemini-response-1"); gate.queue(Buffer.from([0x01, 0x00]));
  const released = gate.flush();
  assert.equal(released[0].responseId, "gemini-response-1");
  gate.noteQueued("gemini-response-1");
  assert.throws(() => gate.bind("gemini-response-2"), /already owned/);
});

test("normal playback remains owned until the exact Telnyx drain mark returns", () => {
  const gate = new BoundPlaybackGate(64 * 1024);
  gate.bind("gemini-response-1"); gate.queue(Buffer.from([0x01, 0x00]));
  const [chunk] = gate.flush(); gate.noteQueued(chunk.responseId);
  const mark = gate.finish("gemini-response-1");
  assert.match(mark, /^ia-gemini-playback:drain:/);
  assert.equal(gate.observeReturnedMark("unrelated-mark"), null);
  assert.deepEqual(gate.observeReturnedMark(mark), { type: "ASSISTANT_AUDIO_STOPPED", responseId: "gemini-response-1", kind: "NORMAL" });
  assert.equal(gate.activeResponseId(), null);
  gate.bind("gemini-response-2");
});

test("authorized clear supersedes pending drain by mark identity", () => {
  const gate = new BoundPlaybackGate(64 * 1024);
  gate.bind("gemini-response-1"); gate.queue(Buffer.from([0x01, 0x00]));
  const [chunk] = gate.flush(); gate.noteQueued(chunk.responseId);
  const drain = gate.finish("gemini-response-1");
  const clear = gate.requestClear("gemini-response-1");
  assert.notEqual(clear, drain);
  assert.equal(gate.observeReturnedMark(drain), null);
  assert.deepEqual(gate.observeReturnedMark(clear), { type: "ASSISTANT_AUDIO_CLEARED", responseId: "gemini-response-1", kind: "NORMAL" });
});

test("response with no queued audio releases binding without inventing playback stop", () => {
  const gate = new BoundPlaybackGate(64 * 1024);
  gate.bind("gemini-response-1");
  assert.equal(gate.finish("gemini-response-1"), null);
  assert.equal(gate.activeResponseId(), null);
  assert.equal(gate.snapshot().binding, null);
});

test("Gemini playback binding buffer is bounded", () => {
  const gate = new BoundPlaybackGate(4);
  gate.queue(Buffer.from([0, 0, 0, 0]));
  assert.throws(() => gate.queue(Buffer.from([0, 0])), /buffer limit exceeded/);
});
