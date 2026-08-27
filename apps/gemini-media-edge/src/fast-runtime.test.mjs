import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { FastGeminiRealtimeSession } from "./fast-runtime.mjs";

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.listeners = new Map();
    this.sent = [];
    this.closed = null;
  }
  on(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    return this;
  }
  emit(type, value) {
    for (const listener of this.listeners.get(type) ?? []) listener(value);
  }
  open() { this.readyState = 1; this.emit("open"); }
  send(value) { this.sent.push(typeof value === "string" ? JSON.parse(value) : value); }
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
  message(value) { this.emit("message", JSON.stringify(value)); }
}

function bootstrap() {
  return Object.freeze({
    version: "gemini-fast-bootstrap.v1",
    provider: "GEMINI",
    credentialId: "cred-runtime",
    tenantId: "tenant-runtime",
    callControlId: "v3:runtime-call",
    notAfterEpochMs: Date.now() + 60_000,
    systemInstruction: "Responde de forma breve y natural.",
    tools: Object.freeze([Object.freeze({
      name: "restaurant_reservation_create",
      description: "Create or continue a reservation.",
      parameters: Object.freeze({ type: "object", properties: Object.freeze({}) }),
    })]),
    voiceName: "Kore",
    languageCode: "es-ES",
  });
}

function callerMedia(chunk = 1) {
  const pcm = Buffer.alloc(320 * 2);
  return {
    event: "media",
    media: { track: "inbound", chunk, payload: pcm.toString("base64") },
  };
}

function geminiAudioPart() {
  const pcm = Buffer.alloc(480 * 2);
  return { inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm.toString("base64") } };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("fast runtime buffers caller audio only until setupComplete then streams directly", async () => {
  const telnyx = new FakeSocket();
  telnyx.readyState = 1;
  let gemini;
  const diagnostics = [];
  const session = new FastGeminiRealtimeSession({
    telnyxSocket: telnyx,
    bootstrap: bootstrap(),
    geminiApiKey: "test-key-not-production",
    toolHandlers: { restaurant_reservation_create: async () => ({ status: "OK" }) },
    createGeminiSocket() { gemini = new FakeSocket(); return gemini; },
    observe: (event) => diagnostics.push(event),
  }).start();

  telnyx.message(callerMedia(1));
  assert.equal(session.snapshot().queuedCallerChunks, 1);

  gemini.open();
  assert.equal(gemini.sent[0].setup.model, "models/gemini-3.1-flash-live-preview");
  gemini.message({ setupComplete: {} });
  assert.equal(session.snapshot().setupComplete, true);
  assert.equal(session.snapshot().queuedCallerChunks, 0);
  assert.equal(gemini.sent[1].realtimeInput.audio.mimeType, "audio/pcm;rate=16000");

  telnyx.message(callerMedia(2));
  assert.equal(gemini.sent[2].realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.equal(diagnostics.some((item) => item.stage === "PRESETUP_CALLER_AUDIO_FLUSHED"), true);
  session.close("test-complete");
});

test("fast runtime sends native Gemini audio to Telnyx and clears immediately on interruption", async () => {
  const telnyx = new FakeSocket();
  telnyx.readyState = 1;
  let gemini;
  const session = new FastGeminiRealtimeSession({
    telnyxSocket: telnyx,
    bootstrap: bootstrap(),
    geminiApiKey: "test-key-not-production",
    toolHandlers: { restaurant_reservation_create: async () => ({ status: "OK" }) },
    createGeminiSocket() { gemini = new FakeSocket(); return gemini; },
  }).start();
  gemini.open();
  gemini.message({ setupComplete: {} });
  gemini.message({
    serverContent: { modelTurn: { parts: [geminiAudioPart(), geminiAudioPart()] } },
  });
  const media = telnyx.sent.filter((item) => item.event === "media");
  assert.equal(media.length, 2);
  assert.ok(Buffer.from(media[0].media.payload, "base64").length > 0);

  gemini.message({ serverContent: { interrupted: true } });
  assert.deepEqual(telnyx.sent.at(-1), { event: "clear" });
  session.close("test-complete");
});

test("passive speech-end latency bookkeeping happens only after response audio is sent", () => {
  const telnyx = new FakeSocket();
  telnyx.readyState = 1;
  let gemini;
  const order = [];
  const diagnostics = [];
  const originalSend = telnyx.send.bind(telnyx);
  telnyx.send = (value) => {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed?.event === "media") order.push("telnyx-media-sent");
    originalSend(value);
  };
  const session = new FastGeminiRealtimeSession({
    telnyxSocket: telnyx,
    bootstrap: bootstrap(),
    geminiApiKey: "test-key-not-production",
    createGeminiSocket() { gemini = new FakeSocket(); return gemini; },
    observe: (event) => {
      diagnostics.push(event);
      if (event.stage === "GEMINI_TURN_COMPLETE") order.push("turn-latency-observed");
    },
  }).start();
  gemini.open();
  gemini.message({ setupComplete: {} });

  gemini.message({ serverContent: { speechState: "NON_SPEECH" } });
  gemini.message({ serverContent: { modelTurn: { parts: [geminiAudioPart()] } } });
  assert.deepEqual(order, ["telnyx-media-sent"]);

  gemini.message({ serverContent: { turnComplete: true } });
  assert.deepEqual(order, ["telnyx-media-sent", "turn-latency-observed"]);
  const turn = diagnostics.findLast((event) => event.stage === "GEMINI_TURN_COMPLETE");
  assert.equal(Number.isSafeInteger(turn.observedMs), true);
  assert.ok(turn.observedMs >= 0);
  assert.equal(turn.phase, "speech_end_to_first_audio");
  assert.equal(turn.type, "gemini_speech_state");
  session.close("test-complete");
});

test("fast runtime executes Gemini tool locally and continues same Live session", async () => {
  const telnyx = new FakeSocket();
  telnyx.readyState = 1;
  let gemini;
  let effects = 0;
  const session = new FastGeminiRealtimeSession({
    telnyxSocket: telnyx,
    bootstrap: bootstrap(),
    geminiApiKey: "test-key-not-production",
    toolHandlers: {
      restaurant_reservation_create: async (call, context) => {
        effects += 1;
        assert.equal(context.tenantId, "tenant-runtime");
        return { status: "NEEDS_TIME", party_size: call.args.party_size };
      },
    },
    createGeminiSocket() { gemini = new FakeSocket(); return gemini; },
  }).start();
  gemini.open();
  gemini.message({ setupComplete: {} });
  gemini.message({
    toolCall: { functionCalls: [{
      id: "tool-fast-1",
      name: "restaurant_reservation_create",
      args: { party_size: 2 },
    }] },
  });
  await settle();
  await settle();
  const toolResponse = gemini.sent.find((item) => item.toolResponse);
  assert.deepEqual(toolResponse, {
    toolResponse: {
      functionResponses: [{
        id: "tool-fast-1",
        name: "restaurant_reservation_create",
        response: { result: { status: "NEEDS_TIME", party_size: 2 } },
      }],
    },
  });
  assert.equal(effects, 1);
  assert.equal(gemini.closed, null);
  session.close("test-complete");
});

test("fast runtime has no legacy hybrid hot-path imports", async () => {
  const source = await readFile(new URL("./fast-runtime.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  const forbidden = [
    "control-sideband",
    "google-speech",
    "google-text-to-speech",
    "semantic-preselection",
    "semantic-tool-gate",
    "governed-speech",
    "isolated-decision",
    "isolated-generation",
    "gemini-call-session",
  ];
  for (const specifier of imports) {
    for (const value of forbidden) assert.equal(specifier.includes(value), false, `fast runtime must not import ${value}`);
  }
});
