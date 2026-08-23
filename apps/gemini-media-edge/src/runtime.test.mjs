import test from "node:test";
import assert from "node:assert/strict";
import { BoundPlaybackGate, Pcm16Resampler24To16, swapPcm16Endianness } from "./runtime.mjs";

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
  gate.bind("gemini-response-1");
  gate.queue(Buffer.from([0x01, 0x00]));
  const released = gate.flush();
  assert.equal(released[0].responseId, "gemini-response-1");
  gate.noteQueued("gemini-response-1");
  assert.throws(() => gate.bind("gemini-response-2"), /already owned/);
});

test("Gemini playback binding buffer is bounded", () => {
  const gate = new BoundPlaybackGate(4);
  gate.queue(Buffer.from([0, 0, 0, 0]));
  assert.throws(() => gate.queue(Buffer.from([0, 0])), /buffer limit exceeded/);
});
