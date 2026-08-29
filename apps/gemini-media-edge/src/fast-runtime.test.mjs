import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { FastGeminiRealtimeSession } from "./fast-runtime.mjs";
import {
  FAST_HORIZONTAL_TOOL_POLICIES,
  defineFastToolPolicy,
  mergeFastToolPolicies,
} from "./fast-tool-authorization-kernel.mjs";

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

const reservationPolicy = defineFastToolPolicy({
  authority: "CALLER_REQUEST",
  effect: "MUTATE_BUSINESS_DATA",
  capability: "reservation.create",
});

const TEST_TOOL_POLICIES = mergeFastToolPolicies(FAST_HORIZONTAL_TOOL_POLICIES, {
  restaurant_reservation_create: reservationPolicy,
});

const RESERVATION_TOOL = Object.freeze({
  name: "restaurant_reservation_create",
  capability: "reservation.create",
  description: "Create or continue a reservation.",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({ party_size: Object.freeze({ type: "integer" }) }),
  }),
});

const TRANSFER_TOOL = Object.freeze({
  name: "transfer_call",
  capability: "call.transfer",
  description: "Transfer the caller to a human.",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({ reason: Object.freeze({ type: "string" }) }),
    required: Object.freeze(["reason"]),
  }),
});

function bootstrap(tools = [RESERVATION_TOOL]) {
  return Object.freeze({
    version: "gemini-fast-bootstrap.v2",
    provider: "GEMINI",
    credentialId: "cred-runtime",
    tenantId: "tenant-runtime",
    callControlId: "v3:runtime-call",
    notAfterEpochMs: Date.now() + 60_000,
    securityContext: Object.freeze({
      callerPhoneE164: "+34600000000",
      calledPhoneE164: "+34910000001",
    }),
    systemInstruction: "Responde de forma breve y natural.",
    tools: Object.freeze(tools),
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

function sessionOptions(telnyx, createGeminiSocket, extra = {}) {
  return {
    telnyxSocket: telnyx,
    bootstrap: extra.bootstrap ?? bootstrap(),
    geminiApiKey: "test-key-not-production",
    toolPolicies: TEST_TOOL_POLICIES,
    createGeminiSocket,
    ...extra,
  };
}

test("fast runtime buffers caller audio only until setupComplete then streams directly", async () => {
  const telnyx = new FakeSocket();
  telnyx.readyState = 1;
  let gemini;
  const diagnostics = [];
  const session = new FastGeminiRealtimeSession(sessionOptions(
    telnyx,
    () => { gemini = new FakeSocket(); return gemini; },
    {
      toolHandlers: { restaurant_reservation_create: async () => ({ status: "OK" }) },
      observe: (event) => diagnostics.push(event),
    },
  )).start();

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
  const session = new FastGeminiRealtimeSession(sessionOptions(
    telnyx,
    () => { gemini = new FakeSocket(); return gemini; },
    { toolHandlers: { restaurant_reservation_create: async () => ({ status: "OK" }) } },
  )).start();
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

test("fast runtime authorizes then executes a business tool and continues same Live session", async () => {
  const telnyx = new FakeSocket();
  telnyx.readyState = 1;
  let gemini;
  let effects = 0;
  const diagnostics = [];
  const session = new FastGeminiRealtimeSession(sessionOptions(
    telnyx,
    () => { gemini = new FakeSocket(); return gemini; },
    {
      toolHandlers: {
        restaurant_reservation_create: async (call, context) => {
          effects += 1;
          assert.equal(context.tenantId, "tenant-runtime");
          return { status: "NEEDS_TIME", party_size: call.args.party_size };
        },
      },
      observe: (event) => diagnostics.push(event),
    },
  )).start();
  gemini.open();
  gemini.message({ setupComplete: {} });
  gemini.message({ serverContent: { inputTranscription: { text: "Quiero reservar para dos personas" } } });
  gemini.message({
    toolCall: { functionCalls: [{
      id: "tool-fast-1",
      name: "restaurant_reservation_create",
      args: {
        party_size: 2,
        authorization: "CALLER_REQUEST",
        caller_authority_evidence: "Quiero reservar para dos personas",
      },
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
  assert.equal(diagnostics.some((item) => item.stage === "TOOL_AUTHORIZATION_ALLOWED"), true);
  assert.equal(session.snapshot().toolAuthorization.allowed, 1);
  assert.equal(gemini.closed, null);
  session.close("test-complete");
});

test("fast runtime blocks an ungrounded business tool before any side effect", async () => {
  const telnyx = new FakeSocket();
  telnyx.readyState = 1;
  let gemini;
  let effects = 0;
  const diagnostics = [];
  const session = new FastGeminiRealtimeSession(sessionOptions(
    telnyx,
    () => { gemini = new FakeSocket(); return gemini; },
    {
      toolHandlers: {
        restaurant_reservation_create: async () => { effects += 1; return { ok: true }; },
      },
      observe: (event) => diagnostics.push(event),
    },
  )).start();
  gemini.open();
  gemini.message({ setupComplete: {} });
  gemini.message({ serverContent: { inputTranscription: { text: "Solo quería saber dónde estáis" } } });
  gemini.message({
    toolCall: { functionCalls: [{
      id: "tool-fast-blocked",
      name: "restaurant_reservation_create",
      args: {
        party_size: 2,
        authorization: "CALLER_REQUEST",
        caller_authority_evidence: "Quiero reservar para dos personas",
      },
    }] },
  });
  await settle();
  await settle();

  assert.equal(effects, 0);
  const response = gemini.sent.find((item) => item.toolResponse)?.toolResponse.functionResponses[0].response.result;
  assert.equal(response.tool_authorized, false);
  assert.equal(response.status, "TOOL_AUTHORITY_EVIDENCE_MISMATCH");
  const blocked = diagnostics.find((item) => item.stage === "TOOL_AUTHORIZATION_BLOCKED");
  assert.equal(blocked.kind, "restaurant_reservation_create");
  assert.equal(blocked.capability, "reservation.create");
  assert.equal(session.snapshot().toolAuthorization.blocked, 1);
  assert.equal(gemini.closed, null);
  session.close("test-complete");
});

test("fast runtime blocks transfer before its special effect sink when caller evidence is ungrounded", async () => {
  const telnyx = new FakeSocket();
  telnyx.readyState = 1;
  let gemini;
  let transferAuthorizations = 0;
  const session = new FastGeminiRealtimeSession(sessionOptions(
    telnyx,
    () => { gemini = new FakeSocket(); return gemini; },
    {
      bootstrap: bootstrap([TRANSFER_TOOL]),
      authorizeTransfer: async () => { transferAuthorizations += 1; return { ok: true }; },
      startTransfer: async () => { throw new Error("transfer start must be unreachable"); },
    },
  )).start();

  gemini.open();
  gemini.message({ setupComplete: {} });
  gemini.message({ serverContent: { inputTranscription: { text: "Quiero conocer vuestro horario" } } });
  gemini.message({
    toolCall: { functionCalls: [{
      id: "transfer-fast-blocked",
      name: "transfer_call",
      args: {
        authorization: "EXPLICIT_REQUEST",
        caller_authority_evidence: "Quiero hablar con una persona",
      },
    }] },
  });
  await settle();
  await settle();

  assert.equal(transferAuthorizations, 0);
  const response = gemini.sent.find((item) => item.toolResponse)?.toolResponse.functionResponses[0].response.result;
  assert.equal(response.status, "TOOL_AUTHORITY_EVIDENCE_MISMATCH");
  assert.equal(session.snapshot().toolAuthorization.blocked, 1);
  assert.equal(gemini.closed, null);
  session.close("test-complete");
});

test("fast runtime carries existing call audit context from generic authorization into transfer start", async () => {
  const telnyx = new FakeSocket();
  telnyx.readyState = 1;
  let gemini;
  let authorizeInput = null;
  let startInput = null;
  const diagnostics = [];
  const session = new FastGeminiRealtimeSession(sessionOptions(
    telnyx,
    () => { gemini = new FakeSocket(); return gemini; },
    {
      bootstrap: bootstrap([TRANSFER_TOOL]),
      authorizeTransfer: async (input) => {
        authorizeInput = input;
        return {
          ok: true,
          status: "HUMAN_HANDOFF_ACCEPTED",
          handoffId: "00000000-0000-4000-8000-000000000001",
          successMessage: "Te paso con recepción. Un momento, por favor.",
        };
      },
      startTransfer: async (input) => {
        startInput = input;
        return { ok: true, status: "DIALING" };
      },
      observe: (event) => diagnostics.push(event),
    },
  )).start();

  gemini.open();
  gemini.message({ setupComplete: {} });
  gemini.message({ serverContent: { inputTranscription: { text: "Quiero hablar con una persona de recepción" } } });
  gemini.message({
    toolCall: { functionCalls: [{
      id: "transfer-fast-1",
      name: "transfer_call",
      args: {
        reason: "USER_REQUESTED_HUMAN",
        context_summary: "El caller pide hablar con recepción.",
        authorization: "EXPLICIT_REQUEST",
        caller_authority_evidence: "Quiero hablar con una persona de recepción",
      },
    }] },
  });
  await settle();
  await settle();

  assert.deepEqual(authorizeInput, {
    tenantId: "tenant-runtime",
    callControlId: "v3:runtime-call",
    calledPhoneE164: "+34910000001",
    callerPhoneE164: "+34600000000",
    reason: "USER_REQUESTED_HUMAN",
    contextSummary: "El caller pide hablar con recepción.",
  });
  const genericAllowed = diagnostics.find((item) => item.stage === "TOOL_AUTHORIZATION_ALLOWED");
  assert.equal(genericAllowed.kind, "transfer_call");
  assert.equal(genericAllowed.source, "EXPLICIT_REQUEST");

  gemini.message({ serverContent: { turnComplete: true } });
  await settle();
  await settle();
  assert.deepEqual(startInput, {
    tenantId: "tenant-runtime",
    callControlId: "v3:runtime-call",
    calledPhoneE164: "+34910000001",
    callerPhoneE164: "+34600000000",
    handoffId: "00000000-0000-4000-8000-000000000001",
    reason: "USER_REQUESTED_HUMAN",
    contextSummary: "El caller pide hablar con recepción.",
  });
  assert.equal(session.snapshot().closed, true);
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
