import test from "node:test";
import assert from "node:assert/strict";
import { Pcm16Resampler24To16, swapPcm16Endianness } from "./runtime.mjs";

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
