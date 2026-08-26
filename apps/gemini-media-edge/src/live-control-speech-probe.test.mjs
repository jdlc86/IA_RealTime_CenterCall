import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  GEMINI_CONTROL_SPEECH_PROBE_TURN_COUNT,
  GEMINI_CONTROL_SPEECH_PROBE_VOICE,
  runGeminiLiveControlSpeechProbe,
} from "./live-control-speech-probe.mjs";

class FakeSocket extends EventEmitter {
  constructor(mode = "ready") {
    super();
    this.mode = mode;
    this.readyState = 1;
    this.realtimeInputs = 0;
    queueMicrotask(() => this.emit("open"));
  }

  send(raw) {
    const message = JSON.parse(raw);
    if (message.setup) {
      queueMicrotask(() => this.emit("message", JSON.stringify({ setupComplete: {} })));
      return;
    }
    if (!message.realtimeInput?.text) return;
    this.realtimeInputs += 1;
    const turn = this.realtimeInputs;
    if (this.mode === "tool" && turn === 1) {
      queueMicrotask(() => this.emit("message", JSON.stringify({
        toolCall: { functionCalls: [{ id: "call-1", name: "unexpected_tool", args: {} }] },
      })));
      return;
    }
    if (this.mode === "silent" && turn === 1) {
      queueMicrotask(() => this.emit("message", JSON.stringify({ serverContent: { turnComplete: true } })));
      return;
    }
    queueMicrotask(() => this.emit("message", JSON.stringify({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from(`audio-${turn}`).toString("base64") } }] },
      },
    })));
    queueMicrotask(() => this.emit("message", JSON.stringify({ serverContent: { turnComplete: true } })));
  }

  terminate() { this.readyState = 3; }
  close() { this.readyState = 3; }
}

const base = Object.freeze({ apiKey: "test-key", model: "gemini-3.1-flash-live-preview", timeoutMs: 1_000 });

test("control speech probe proves two native audio turns in one configured-voice session", async () => {
  const socket = new FakeSocket("ready");
  const result = await runGeminiLiveControlSpeechProbe({ ...base, createSocket: () => socket });
  assert.equal(result.status, "ready");
  assert.equal(result.nativeAudio, true);
  assert.equal(result.sameLiveSession, true);
  assert.equal(result.configuredVoice, GEMINI_CONTROL_SPEECH_PROBE_VOICE);
  assert.equal(result.controlTurns, GEMINI_CONTROL_SPEECH_PROBE_TURN_COUNT);
  assert.equal(socket.realtimeInputs, 2);
  assert.equal(result.audioBytes.length, 2);
  assert.ok(result.audioBytes.every((value) => value > 0));
});

test("control speech probe fails closed on an unexpected tool call", async () => {
  const result = await runGeminiLiveControlSpeechProbe({ ...base, createSocket: () => new FakeSocket("tool") });
  assert.deepEqual(result, { status: "failed", failureCategory: "UNEXPECTED_TOOL_CALL", controlTurn: 1 });
});

test("control speech probe rejects a completed control turn without native audio", async () => {
  const result = await runGeminiLiveControlSpeechProbe({ ...base, createSocket: () => new FakeSocket("silent") });
  assert.deepEqual(result, { status: "failed", failureCategory: "TURN_COMPLETE_WITHOUT_AUDIO", controlTurn: 1 });
});
