import assert from "node:assert/strict";
import test from "node:test";
import { FastGeminiRealtimeSession } from "./fast-runtime.mjs";
import { InMemoryDiagnosticJournal } from "./diagnostic-journal.mjs";
import { FAST_HORIZONTAL_TOOL_POLICIES } from "./fast-tool-authorization-kernel.mjs";

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
    credentialId: "cred-temporal-diagnostic",
    tenantId: "tenant-temporal-diagnostic",
    callControlId: "v3:temporal-diagnostic",
    notAfterEpochMs: Date.now() + 60_000,
    securityContext: Object.freeze({
      callerPhoneE164: "+34600000000",
      calledPhoneE164: "+34910000001",
    }),
    systemInstruction: "Usa el reloj autoritativo solo cuando sea semánticamente necesario para la petición del caller.",
    tools: Object.freeze([Object.freeze({
      name: "get_authoritative_datetime",
      description: "Get authoritative current date and time.",
      parameters: Object.freeze({ type: "object", properties: Object.freeze({}) }),
    })]),
    voiceName: "Kore",
    languageCode: "es-ES",
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function runTemporalTool(result, options = {}) {
  const telnyx = new FakeSocket();
  telnyx.readyState = 1;
  let gemini;
  const observed = [];
  let handlerCalls = 0;
  const session = new FastGeminiRealtimeSession({
    telnyxSocket: telnyx,
    bootstrap: bootstrap(),
    geminiApiKey: "test-key-not-production",
    toolPolicies: FAST_HORIZONTAL_TOOL_POLICIES,
    toolHandlers: {
      get_authoritative_datetime: async () => {
        handlerCalls += 1;
        return result;
      },
    },
    createGeminiSocket() { gemini = new FakeSocket(); return gemini; },
    observe: (event) => observed.push(event),
  }).start();

  gemini.open();
  gemini.message({ setupComplete: {} });
  gemini.message({ serverContent: { inputTranscription: { text: options.transcript ?? "¿Qué hora es ahora?" } } });
  gemini.message({
    toolCall: { functionCalls: [{
      id: "temporal-tool-1",
      name: "get_authoritative_datetime",
      args: {
        authorization: "SEMANTIC_NECESSITY",
        caller_authority_evidence: options.evidence ?? "Qué hora es ahora",
      },
    }] },
  });
  await settle();
  await settle();
  session.close("test-complete");
  return Object.freeze({ observed, handlerCalls, gemini });
}

test("verified temporal tool persists authorization then only kind and WORKER_CLOCK result source", async () => {
  const run = await runTemporalTool(Object.freeze({
    ok: true,
    status: "AUTHORITATIVE_DATETIME",
    time_authoritative: true,
    authoritative_temporal_context: Object.freeze({
      version: 1,
      source: "WORKER_CLOCK",
      timezone: "Europe/Madrid",
      captured_at_epoch_ms: 1_787_900_000_000,
      now_iso: "2026-08-28T10:13:20+02:00",
      local_date: "2026-08-28",
      local_time: "10:13:20",
      weekday: "viernes",
    }),
    instruction: "Dato temporal certificado por el kernel.",
  }));

  assert.equal(run.handlerCalls, 1);
  const authorization = run.observed.find((event) => event.stage === "TOOL_AUTHORIZATION_ALLOWED");
  assert.equal(authorization.kind, "get_authoritative_datetime");
  assert.equal(authorization.source, "SEMANTIC_NECESSITY");
  assert.equal(authorization.effect, "READ_CONTEXT");
  assert.equal(authorization.capability, "time.authoritative");

  const toolEvent = run.observed.find((event) => event.stage === "TOOL_RESULT_SENT");
  assert.equal(toolEvent.kind, "AUTHORITATIVE_DATETIME");
  assert.equal(toolEvent.source, "WORKER_CLOCK");

  const journal = new InMemoryDiagnosticJournal({ ttlMs: 60_000 });
  const persistedAuth = journal.record(authorization, 1_999_999);
  assert.deepEqual(persistedAuth.details, {
    kind: "get_authoritative_datetime",
    source: "SEMANTIC_NECESSITY",
    authority: "SEMANTIC_NECESSITY",
    effect: "READ_CONTEXT",
    capability: "time.authoritative",
  });
  const persisted = journal.record(toolEvent, 2_000_000);
  assert.deepEqual(persisted.details, {
    kind: "AUTHORITATIVE_DATETIME",
    source: "WORKER_CLOCK",
  });
  const serialized = JSON.stringify([persistedAuth, persisted]);
  assert.equal(serialized.includes("temporal-tool-1"), false);
  assert.equal(serialized.includes("2026-08-28T10:13:20+02:00"), false);
  assert.equal(serialized.includes("Europe/Madrid"), false);
  assert.equal(serialized.includes("Dato temporal certificado"), false);
});

test("ungrounded temporal proposal is blocked before the Worker clock handler", async () => {
  const run = await runTemporalTool(Object.freeze({ ok: true }), {
    transcript: "Solo quería saber vuestra dirección",
    evidence: "Qué hora es ahora",
  });
  assert.equal(run.handlerCalls, 0);
  const blocked = run.observed.find((event) => event.stage === "TOOL_AUTHORIZATION_BLOCKED");
  assert.equal(blocked.kind, "get_authoritative_datetime");
  assert.equal(blocked.source, "TOOL_AUTHORITY_EVIDENCE_MISMATCH");
  const response = run.gemini.sent.find((item) => item.toolResponse)?.toolResponse.functionResponses[0].response.result;
  assert.equal(response.tool_authorized, false);
  assert.equal(response.status, "TOOL_AUTHORITY_EVIDENCE_MISMATCH");
});

test("unavailable temporal authority never persists a false WORKER_CLOCK source", async () => {
  const run = await runTemporalTool(Object.freeze({
    ok: false,
    status: "TEMPORAL_AUTHORITY_UNAVAILABLE",
    time_authoritative: false,
    instruction: "No inventes fecha ni hora.",
  }));
  const toolEvent = run.observed.find((event) => event.stage === "TOOL_RESULT_SENT");

  assert.equal(toolEvent.kind, "TEMPORAL_AUTHORITY_UNAVAILABLE");
  assert.equal("source" in toolEvent, false);

  const journal = new InMemoryDiagnosticJournal({ ttlMs: 60_000 });
  const persisted = journal.record(toolEvent, 2_100_000);
  assert.deepEqual(persisted.details, { kind: "TEMPORAL_AUTHORITY_UNAVAILABLE" });
  assert.equal("source" in persisted.details, false);
});
