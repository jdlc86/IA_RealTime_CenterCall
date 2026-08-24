import test from "node:test";
import assert from "node:assert/strict";
import {
  BoundPlaybackGate,
  applyCallerInputControlCommand,
  assertMediaEdgeSocketWritable,
  commitDeferredCallerTurn,
  completeGovernedSpeechPlayback,
  executeGovernedSpeechPlayback,
  Pcm16Resampler24To16,
  requirePcm16LittleEndian,
  requestCorrelatedPlaybackClear,
  telnyxStreamingCredential,
} from "./runtime.mjs";
import { GovernedSpeechPlaybackCoordinator } from "./governed-speech-playback-coordinator.mjs";

class FakeSocket {
  constructor() { this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
}

test("media upgrade authenticates the header defined by the Telnyx streaming contract", () => {
  assert.equal(
    telnyxStreamingCredential({ headers: { "x-telnyx-streaming-auth-token": " signed-one-shot-credential " } }),
    "signed-one-shot-credential",
  );
  assert.throws(
    () => telnyxStreamingCredential({ headers: { authorization: "Bearer signed-one-shot-credential" } }),
    /missing Telnyx streaming auth token/,
  );
  assert.throws(
    () => telnyxStreamingCredential({ headers: { "x-telnyx-streaming-auth-token": "   " } }),
    /missing Telnyx streaming auth token/,
  );
});

test("Telnyx WebSocket L16 preserves PCM16 little-endian byte order", () => {
  const source = Buffer.from([0x12, 0x34, 0xab, 0xcd]);
  assert.deepEqual([...requirePcm16LittleEndian(source, "Telnyx L16 payload")], [...source]);
});

test("PCM16 little-endian contract rejects empty and incomplete samples", () => {
  assert.throws(() => requirePcm16LittleEndian(Buffer.alloc(0)), /complete 16-bit little-endian samples/);
  assert.throws(() => requirePcm16LittleEndian(Buffer.from([1])), /complete 16-bit little-endian samples/);
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
    { realtimeInput: { audio: { data: Buffer.from([0x12, 0x34, 0xab, 0xcd]).toString("base64"), mimeType: "audio/pcm;rate=16000" } } },
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

test("governed speech reaches correlated Telnyx drain before response completion", async () => {
  const playback = new BoundPlaybackGate(64 * 1024);
  const coordinator = new GovernedSpeechPlaybackCoordinator();
  const controlEvents = [];
  const telnyxAudio = [];
  const marks = [];
  const syntheses = [];
  const emitControlEvent = (event) => { controlEvents.push(event); return true; };

  const context = await executeGovernedSpeechPlayback({
    command: {
      type: "GOVERNED_SPEECH",
      responseId: "governed-greeting-1",
      text: "Hola, soy Lucía.",
      kind: "GREETING",
      purpose: "initial_greeting",
    },
    synthesize: async ({ text }) => {
      syntheses.push(text);
      return { text, pcm16le: Buffer.from([0x01, 0x02, 0x03, 0x04]), sampleRateHertz: 16_000, encoding: "PCM16_LE" };
    },
    coordinator,
    playback,
    assertSessionActive() {},
    emitControlEvent,
    emitPlaybackChunks(chunks, onFirstQueued) {
      for (const chunk of chunks) {
        telnyxAudio.push(chunk);
        const noted = playback.noteQueued(chunk.responseId);
        if (noted.first) {
          onFirstQueued();
          emitControlEvent({ type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STARTED", responseId: chunk.responseId, kind: chunk.kind } });
        }
      }
    },
    sendDrainMark(mark) { marks.push(mark); },
  });

  assert.deepEqual(syntheses, ["Hola, soy Lucía."]);
  assert.deepEqual(context, { responseId: "governed-greeting-1", kind: "GREETING", purpose: "initial_greeting" });
  assert.equal(telnyxAudio.length, 1);
  assert.deepEqual([...telnyxAudio[0].pcm], [0x01, 0x02, 0x03, 0x04]);
  assert.deepEqual(controlEvents, [
    {
      type: "GOVERNED_EVENT",
      event: {
        type: "ASSISTANT_RESPONSE_STARTED",
        responseId: "governed-greeting-1",
        kind: "GREETING",
        purpose: "initial_greeting",
      },
    },
    {
      type: "PLAYBACK_EVENT",
      event: { type: "ASSISTANT_AUDIO_STARTED", responseId: "governed-greeting-1", kind: "GREETING" },
    },
  ]);
  assert.match(marks[0], /^ia-gemini-playback:drain:/);
  assert.equal(coordinator.snapshot().activeResponseId, "governed-greeting-1");

  assert.equal(playback.observeReturnedMark("stale-mark"), null);
  assert.equal(controlEvents.some((event) => event.event?.type === "ASSISTANT_RESPONSE_COMPLETED"), false);
  const stopped = playback.observeReturnedMark(marks[0]);
  completeGovernedSpeechPlayback({ context, event: stopped, coordinator, emitControlEvent });
  assert.deepEqual(controlEvents.slice(-2), [
    {
      type: "PLAYBACK_EVENT",
      event: { type: "ASSISTANT_AUDIO_STOPPED", responseId: "governed-greeting-1", kind: "GREETING" },
    },
    {
      type: "GOVERNED_EVENT",
      event: {
        type: "ASSISTANT_RESPONSE_COMPLETED",
        responseId: "governed-greeting-1",
        kind: "GREETING",
        status: "completed",
      },
    },
  ]);
  assert.deepEqual(coordinator.snapshot(), { pendingResponseId: null, activeResponseId: null });
});

test("governed speech reserves before TTS and rejects Live audio ownership", async () => {
  const playback = new BoundPlaybackGate(64 * 1024);
  const coordinator = new GovernedSpeechPlaybackCoordinator();
  let finishSynthesis;
  const synthesis = new Promise((resolve) => { finishSynthesis = resolve; });
  const execution = executeGovernedSpeechPlayback({
    command: { type: "GOVERNED_SPEECH", responseId: "governed-1", text: "Texto exacto" },
    synthesize: async () => synthesis,
    coordinator,
    playback,
    assertSessionActive() {},
    emitControlEvent: () => true,
    emitPlaybackChunks(chunks, onFirstQueued) {
      for (const chunk of chunks) {
        playback.noteQueued(chunk.responseId);
        onFirstQueued();
      }
    },
    sendDrainMark() {},
  });

  assert.deepEqual(coordinator.snapshot(), { pendingResponseId: "governed-1", activeResponseId: null });
  assert.throws(() => coordinator.assertProviderAudioAllowed(), /forbidden/);
  finishSynthesis({ text: "Texto exacto", pcm16le: Buffer.from([1, 2]), sampleRateHertz: 16_000, encoding: "PCM16_LE" });
  await execution;
});

test("authorized governed clear supersedes drain and completes only on its exact returned mark", async () => {
  const playback = new BoundPlaybackGate(64 * 1024);
  const coordinator = new GovernedSpeechPlaybackCoordinator();
  const controlEvents = [];
  const drainMarks = [];
  const clearTransport = [];
  const emitControlEvent = (event) => { controlEvents.push(event); return true; };
  const context = await executeGovernedSpeechPlayback({
    command: { type: "GOVERNED_SPEECH", responseId: "governed-clear-1", text: "Hola", kind: "GREETING" },
    synthesize: async ({ text }) => ({ text, pcm16le: Buffer.from([1, 2]), sampleRateHertz: 16_000, encoding: "PCM16_LE" }),
    coordinator,
    playback,
    assertSessionActive() {},
    emitControlEvent,
    emitPlaybackChunks(chunks, onFirstQueued) {
      for (const chunk of chunks) {
        playback.noteQueued(chunk.responseId);
        onFirstQueued();
        emitControlEvent({ type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_STARTED", responseId: chunk.responseId, kind: chunk.kind } });
      }
    },
    sendDrainMark(mark) { drainMarks.push(mark); },
  });

  assert.throws(
    () => requestCorrelatedPlaybackClear({
      command: { type: "PLAYBACK_CLEAR", responseId: "other" }, playback, sendClear() {}, sendMark() {},
    }),
    /identity mismatch/,
  );
  const clearMark = requestCorrelatedPlaybackClear({
    command: { type: "PLAYBACK_CLEAR", responseId: context.responseId },
    playback,
    sendClear() { clearTransport.push("clear"); },
    sendMark(mark) { clearTransport.push(mark); },
  });
  assert.deepEqual(clearTransport, ["clear", clearMark]);
  assert.equal(playback.observeReturnedMark(drainMarks[0]), null);
  const cleared = playback.observeReturnedMark(clearMark);
  completeGovernedSpeechPlayback({ context, event: cleared, coordinator, emitControlEvent });
  assert.deepEqual(controlEvents.slice(-2), [
    { type: "PLAYBACK_EVENT", event: { type: "ASSISTANT_AUDIO_CLEARED", responseId: "governed-clear-1", kind: "GREETING" } },
    { type: "GOVERNED_EVENT", event: { type: "ASSISTANT_RESPONSE_COMPLETED", responseId: "governed-clear-1", kind: "GREETING", status: "completed" } },
  ]);
});

test("physical playback owner preserves governed handoff kind through Telnyx drain", () => {
  const playback = new BoundPlaybackGate(64 * 1024);
  playback.queue(Buffer.from([1, 2]));
  const chunks = playback.bind("handoff-1", "HANDOFF");
  assert.deepEqual(chunks.map(({ responseId, kind, pcm }) => ({ responseId, kind, pcm: [...pcm] })), [
    { responseId: "handoff-1", kind: "HANDOFF", pcm: [1, 2] },
  ]);
  playback.noteQueued("handoff-1");
  const mark = playback.finish("handoff-1");
  assert.deepEqual(playback.observeReturnedMark(mark), {
    type: "ASSISTANT_AUDIO_STOPPED",
    responseId: "handoff-1",
    kind: "HANDOFF",
  });
});

test("governed speech rejects a stale session after late TTS without playback", async () => {
  const playback = new BoundPlaybackGate(64 * 1024);
  const coordinator = new GovernedSpeechPlaybackCoordinator();
  let emitted = false;
  await assert.rejects(
    executeGovernedSpeechPlayback({
      command: { type: "GOVERNED_SPEECH", responseId: "governed-late", text: "Hola" },
      synthesize: async ({ text }) => ({ text, pcm16le: Buffer.from([1, 2]), sampleRateHertz: 16_000, encoding: "PCM16_LE" }),
      coordinator,
      playback,
      assertSessionActive() { throw new Error("session closed"); },
      emitControlEvent: () => true,
      emitPlaybackChunks() { emitted = true; },
      sendDrainMark() { emitted = true; },
    }),
    /session closed/,
  );
  assert.equal(emitted, false);
  assert.equal(playback.snapshot().pendingBytes, 0);
  assert.deepEqual(coordinator.snapshot(), { pendingResponseId: null, activeResponseId: null });
});

test("governed speech resets ownership on closed Telnyx socket and backpressure", async (t) => {
  for (const failure of [
    { name: "closed socket", socket: { readyState: 3, bufferedAmount: 0 }, error: /socket is not open/ },
    { name: "backpressure", socket: { readyState: 1, bufferedAmount: 65_537 }, error: /backpressure limit exceeded/ },
  ]) {
    await t.test(failure.name, async () => {
      const playback = new BoundPlaybackGate(64 * 1024);
      const coordinator = new GovernedSpeechPlaybackCoordinator();
      let drainSent = false;
      await assert.rejects(
        executeGovernedSpeechPlayback({
          command: { type: "GOVERNED_SPEECH", responseId: `governed-${failure.name}`, text: "Hola" },
          synthesize: async ({ text }) => ({ text, pcm16le: Buffer.from([1, 2]), sampleRateHertz: 16_000, encoding: "PCM16_LE" }),
          coordinator,
          playback,
          assertSessionActive() {},
          emitControlEvent: () => true,
          emitPlaybackChunks() { assertMediaEdgeSocketWritable(failure.socket, "Telnyx", 64 * 1024); },
          sendDrainMark() { drainSent = true; },
        }),
        failure.error,
      );
      assert.equal(drainSent, false);
      assert.deepEqual(playback.snapshot(), {
        binding: null,
        bindingKind: null,
        pendingChunks: 0,
        pendingBytes: 0,
        playback: { responseId: null, started: false, pendingMark: null, pendingPurpose: null },
      });
      assert.deepEqual(coordinator.snapshot(), { pendingResponseId: null, activeResponseId: null });
    });
  }
});

test("governed speech rechecks sideband ownership at the physical playback boundary", async () => {
  const playback = new BoundPlaybackGate(64 * 1024);
  const coordinator = new GovernedSpeechPlaybackCoordinator();
  let assertions = 0;
  let physicalEffects = 0;
  await assert.rejects(
    executeGovernedSpeechPlayback({
      command: { type: "GOVERNED_SPEECH", responseId: "governed-detached", text: "Hola" },
      synthesize: async ({ text }) => ({ text, pcm16le: Buffer.from([1, 2]), sampleRateHertz: 16_000, encoding: "PCM16_LE" }),
      coordinator,
      playback,
      assertSessionActive() { assertions += 1; if (assertions === 2) throw new Error("control sideband detached"); },
      emitControlEvent: () => true,
      emitPlaybackChunks() { physicalEffects += 1; },
      sendDrainMark() { physicalEffects += 1; },
    }),
    /control sideband detached/,
  );
  assert.equal(assertions, 2);
  assert.equal(physicalEffects, 0);
  assert.deepEqual(playback.snapshot(), {
    binding: null,
    bindingKind: null,
    pendingChunks: 0,
    pendingBytes: 0,
    playback: { responseId: null, started: false, pendingMark: null, pendingPurpose: null },
  });
  assert.deepEqual(coordinator.snapshot(), { pendingResponseId: null, activeResponseId: null });
});

test("governed completion fails closed when its sideband delivery disappears", async (t) => {
  for (const failure of [
    { name: "before playback completion", delivered: () => false, error: /playback completion requires active control sideband/ },
    { name: "before response completion", delivered: (() => { let calls = 0; return () => { calls += 1; return calls === 1; }; })(), error: /response completion requires active control sideband/ },
  ]) {
    await t.test(failure.name, async () => {
      const playback = new BoundPlaybackGate(64 * 1024);
      const coordinator = new GovernedSpeechPlaybackCoordinator();
      const marks = [];
      const context = await executeGovernedSpeechPlayback({
        command: { type: "GOVERNED_SPEECH", responseId: `governed-completion-${failure.name}`, text: "Hola" },
        synthesize: async ({ text }) => ({ text, pcm16le: Buffer.from([1, 2]), sampleRateHertz: 16_000, encoding: "PCM16_LE" }),
        coordinator,
        playback,
        assertSessionActive() {},
        emitControlEvent: () => true,
        emitPlaybackChunks(chunks, onFirstQueued) { for (const chunk of chunks) { playback.noteQueued(chunk.responseId); onFirstQueued(); } },
        sendDrainMark(mark) { marks.push(mark); },
      });
      const stopped = playback.observeReturnedMark(marks[0]);
      assert.throws(
        () => completeGovernedSpeechPlayback({ context, event: stopped, coordinator, emitControlEvent: failure.delivered }),
        failure.error,
      );
      assert.deepEqual(coordinator.snapshot(), { pendingResponseId: null, activeResponseId: null });
      assert.equal(playback.activeResponseId(), null);
    });
  }
});

test("runtime caller-input controls mutate only the product-owned edge owner", () => {
  const calls = [];
  const events = [];
  const owner = {
    clear() { calls.push("clear"); },
    suspend() { calls.push("suspend"); },
    restore() { calls.push("restore"); },
  };
  const emit = (event) => { events.push(event); };

  assert.equal(applyCallerInputControlCommand({ type: "INPUT_DETECTION_SUSPEND" }, owner, emit), true);
  assert.equal(applyCallerInputControlCommand({ type: "CALLER_INPUT_CLEAR" }, owner, emit), true);
  assert.equal(applyCallerInputControlCommand({ type: "INPUT_DETECTION_RESTORE" }, owner, emit), true);
  assert.equal(applyCallerInputControlCommand({ type: "TOOL_RESULT" }, owner, emit), false);
  assert.deepEqual(calls, ["suspend", "clear", "restore"]);
  assert.deepEqual(events, [
    { type: "INPUT_DETECTION_EVENT", event: { type: "INPUT_DETECTION_UPDATED", present: true, settings: null } },
    {
      type: "INPUT_DETECTION_EVENT",
      event: {
        type: "INPUT_DETECTION_UPDATED",
        present: true,
        settings: { createResponse: false, interruptResponse: false },
      },
    },
  ]);
});
