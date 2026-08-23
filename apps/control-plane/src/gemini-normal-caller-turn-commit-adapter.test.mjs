import assert from "node:assert/strict";
import test from "node:test";
import { createAuthoritativeCallerTranscriptionPort } from "../.test-dist/authoritative-caller-transcription-port.js";
import { GeminiDeferredBargeInCandidateOwner } from "../.test-dist/gemini-deferred-barge-in-candidate-owner.js";
import { GeminiNormalCallerTurnCommitAdapter } from "../.test-dist/gemini-normal-caller-turn-commit-adapter.js";
import { GeminiTelnyxSessionBridge } from "../.test-dist/gemini-telnyx-session-bridge.js";

function host({ failOn = null } = {}) {
  const sent = [];
  return {
    sent,
    send(message) {
      if (failOn && failOn(message)) throw new Error("wire failed");
      sent.push(message);
    },
  };
}

function setup() {
  return {
    model: "models/gemini-live-test",
    responseModalities: ["AUDIO"],
    manualActivityDetection: true,
    manualActivityHandling: "START_OF_ACTIVITY_INTERRUPTS",
  };
}

function readyBridge(gemini = host(), telnyx = host()) {
  const bridge = new GeminiTelnyxSessionBridge(gemini, telnyx, setup(), { inboundAudioMode: "DEFER" });
  bridge.start();
  bridge.observeGemini(JSON.stringify({ setupComplete: {} }));
  return { bridge, gemini, telnyx };
}

async function releasedTurn(payloads = [Buffer.from([0x00, 0x01]).toString("base64")]) {
  const owner = new GeminiDeferredBargeInCandidateOwner();
  const started = owner.beginCandidate();
  for (const payload of payloads) owner.bufferTelnyxMedia(payload);
  const port = createAuthoritativeCallerTranscriptionPort({
    async transcribe(request) {
      return { itemId: request.itemId, transcript: "turno normal" };
    },
  });
  owner.completeCandidate(await port.transcribe(owner.transcriptionRequest()));
  return owner.releaseNormalTurn(started.itemId);
}

function pcm16le(values) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer.toString("base64");
}

test("released normal turn commits activity and retained audio only while session is idle", async () => {
  const { bridge, gemini } = readyBridge();
  const adapter = new GeminiNormalCallerTurnCommitAdapter(gemini, setup(), bridge);
  const turn = await releasedTurn([
    Buffer.from([0x00, 0x01]).toString("base64"),
    Buffer.from([0x00, 0x02]).toString("base64"),
  ]);
  const before = gemini.sent.length;

  assert.deepEqual(adapter.commit(turn), {
    state: "ACTIVE",
    committedTurns: 1,
    committedChunks: 2,
  });
  assert.deepEqual(gemini.sent.slice(before).map((message) => (
    message.realtimeInput?.activityStart ? "start"
      : message.realtimeInput?.audio ? "audio"
        : message.realtimeInput?.activityEnd ? "end"
          : "other"
  )), ["start", "audio", "audio", "end"]);
});

test("shape-compatible caller turn cannot bypass normal release authority", () => {
  const { bridge, gemini } = readyBridge();
  const adapter = new GeminiNormalCallerTurnCommitAdapter(gemini, setup(), bridge);
  const before = gemini.sent.length;
  assert.throws(
    () => adapter.commit({ itemId: "gemini-candidate-1", transcript: "hola", mediaPayloads: ["AAE="] }),
    /not released as a normal turn/,
  );
  assert.equal(gemini.sent.length, before);
});

test("active model response without playback still blocks normal caller commit", async () => {
  const { bridge, gemini } = readyBridge();
  bridge.observeGemini(JSON.stringify({ toolCall: { functionCalls: [{ id: "fc-1", name: "search" }] } }));
  assert.equal(bridge.activeResponseId(), "gemini-response-1");
  assert.equal(bridge.activePlaybackResponseId(), null);
  const adapter = new GeminiNormalCallerTurnCommitAdapter(gemini, setup(), bridge);
  const turn = await releasedTurn();
  const before = gemini.sent.length;
  assert.throws(() => adapter.commit(turn), /requires idle session/);
  assert.equal(gemini.sent.length, before);
});

test("active Telnyx playback blocks normal caller commit even when caller turn is valid", async () => {
  const { bridge, gemini } = readyBridge();
  bridge.observeGemini(JSON.stringify({
    serverContent: {
      modelTurn: {
        parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm16le([0, 3000, 6000, 9000]) } }],
      },
    },
  }));
  assert.equal(bridge.activePlaybackResponseId(), "gemini-response-1");
  const adapter = new GeminiNormalCallerTurnCommitAdapter(gemini, setup(), bridge);
  const turn = await releasedTurn();
  const before = gemini.sent.length;
  assert.throws(() => adapter.commit(turn), /requires idle session/);
  assert.equal(gemini.sent.length, before);
});

test("same released normal turn cannot be committed twice", async () => {
  const { bridge, gemini } = readyBridge();
  const adapter = new GeminiNormalCallerTurnCommitAdapter(gemini, setup(), bridge);
  const turn = await releasedTurn();
  adapter.commit(turn);
  const before = gemini.sent.length;
  assert.throws(() => adapter.commit(turn), /already committed/);
  assert.equal(gemini.sent.length, before);
});

test("wire failure makes normal commit adapter terminal instead of replaying partial audio", async () => {
  let audioWrites = 0;
  const gemini = host({
    failOn(message) {
      if (message.realtimeInput?.audio) {
        audioWrites += 1;
        return audioWrites === 1;
      }
      return false;
    },
  });
  const { bridge } = readyBridge(gemini, host());
  const adapter = new GeminiNormalCallerTurnCommitAdapter(gemini, setup(), bridge);
  const turn = await releasedTurn();
  assert.throws(() => adapter.commit(turn), /wire failed/);
  assert.equal(adapter.snapshot().state, "FAILED");
  assert.throws(() => adapter.commit(turn), /adapter is failed/);
});
