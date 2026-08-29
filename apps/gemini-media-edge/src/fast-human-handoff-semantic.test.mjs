import assert from "node:assert/strict";
import test from "node:test";
import { buildFastGemini31Setup } from "./fast-gemini31.mjs";
import { authorizeFastHumanHandoff, initialFastHandoffAuthorizationState } from "./fast-human-handoff-policy.mjs";
import { FastGeminiRealtimeSession } from "./fast-runtime.mjs";
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

function transferTool() {
  return Object.freeze({
    name: "transfer_call",
    capability: "call.transfer",
    description: "Transfer the caller to the configured human destination.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        reason: Object.freeze({ type: "string" }),
        context_summary: Object.freeze({ type: "string" }),
      }),
      required: Object.freeze(["reason"]),
    }),
  });
}

function bootstrap() {
  return Object.freeze({
    version: "gemini-fast-bootstrap.v2",
    provider: "GEMINI",
    credentialId: "cred-semantic-handoff",
    tenantId: "tenant-semantic-handoff",
    callControlId: "v3:semantic-handoff",
    notAfterEpochMs: Date.now() + 60_000,
    securityContext: Object.freeze({
      callerPhoneE164: "+34600000000",
      calledPhoneE164: "+34910000001",
    }),
    systemInstruction: "Habla de forma natural y usa las herramientas cuando corresponda.",
    tools: Object.freeze([transferTool()]),
    voiceName: "Kore",
    languageCode: "es-ES",
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("transfer tool uses the same generic authority contract without phrase lists", () => {
  const setup = buildFastGemini31Setup({
    systemInstruction: "Habla con naturalidad.",
    tools: [transferTool()],
    toolPolicies: FAST_HORIZONTAL_TOOL_POLICIES,
  });
  const declaration = setup.setup.tools[0].functionDeclarations[0];
  assert.deepEqual(declaration.parametersJsonSchema.properties.authorization.enum, ["EXPLICIT_REQUEST", "CONFIRMED_OFFER"]);
  assert.equal(declaration.parametersJsonSchema.required.includes("authorization"), true);
  assert.equal(declaration.parametersJsonSchema.required.includes("caller_authority_evidence"), true);
  assert.match(declaration.description, /kernel valida la evidencia/i);
  assert.match(declaration.parametersJsonSchema.properties.caller_authority_evidence.description, /lenguaje natural/i);
});

test("handoff policy accepts free natural wording when Gemini grounds its semantic decision", () => {
  const transcript = "A ver, si no te importa, me gustaría que me comunicaras con alguien del equipo que pueda ayudarme.";
  const decision = authorizeFastHumanHandoff(initialFastHandoffAuthorizationState(), {
    authorization: "EXPLICIT_REQUEST",
    callerAuthorityEvidence: "me gustaría que me comunicaras con alguien del equipo que pueda ayudarme",
    callerTranscript: transcript,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.source, "EXPLICIT_REQUEST");
});

test("handoff policy accepts natural confirmation without enumerating affirmative phrases", () => {
  const transcript = "Venga, hagámoslo; me viene bien que me pases con ellos ahora.";
  const decision = authorizeFastHumanHandoff(initialFastHandoffAuthorizationState(), {
    authorization: "CONFIRMED_OFFER",
    callerAuthorityEvidence: "Venga, hagámoslo; me viene bien que me pases con ellos ahora",
    callerTranscript: transcript,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.source, "CONFIRMED_OFFER");
});

test("handoff policy fails closed when semantic authority is not grounded in the captured caller turn", () => {
  const decision = authorizeFastHumanHandoff(initialFastHandoffAuthorizationState(), {
    authorization: "EXPLICIT_REQUEST",
    callerAuthorityEvidence: "pásame con recepción",
    callerTranscript: "Quería consultar el horario de mañana.",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.source, "CALLER_AUTHORITY_EVIDENCE_MISMATCH");
});

test("fast runtime snapshots caller transcript before same-frame turnComplete can clear mutable state", async () => {
  const telnyx = new FakeSocket();
  telnyx.readyState = 1;
  let gemini;
  let authorizeInput = null;
  let startInput = null;
  const diagnostics = [];
  const session = new FastGeminiRealtimeSession({
    telnyxSocket: telnyx,
    bootstrap: bootstrap(),
    geminiApiKey: "test-key-not-production",
    toolPolicies: FAST_HORIZONTAL_TOOL_POLICIES,
    authorizeTransfer: async (input) => {
      authorizeInput = input;
      return {
        ok: true,
        status: "HUMAN_HANDOFF_ACCEPTED",
        handoffId: "00000000-0000-4000-8000-000000000099",
        successMessage: "Te paso con el equipo. Un momento, por favor.",
      };
    },
    startTransfer: async (input) => {
      startInput = input;
      return { ok: true, status: "DIALING" };
    },
    createGeminiSocket() { gemini = new FakeSocket(); return gemini; },
    observe: (event) => diagnostics.push(event),
  }).start();

  gemini.open();
  gemini.message({ setupComplete: {} });
  const callerText = "Sí, claro; si puedes, pásame con una persona del equipo.";
  gemini.message({
    serverContent: {
      inputTranscription: { text: callerText },
      turnComplete: true,
    },
    toolCall: {
      functionCalls: [{
        id: "transfer-semantic-race",
        name: "transfer_call",
        args: {
          reason: "USER_REQUESTED_HUMAN",
          context_summary: "El caller quiere continuar con una persona.",
          authorization: "EXPLICIT_REQUEST",
          caller_authority_evidence: "si puedes, pásame con una persona del equipo",
        },
      }],
    },
  });

  await settle();
  await settle();
  assert.ok(authorizeInput, "transfer authorization must survive same-frame turnComplete");
  assert.equal(diagnostics.some((event) => event.stage === "TOOL_AUTHORIZATION_ALLOWED"), true);
  assert.equal(diagnostics.some((event) => event.stage === "HUMAN_HANDOFF_AUTHORIZATION_BLOCKED"), false);
  assert.equal(session.snapshot().handoffPending, true);

  gemini.message({ serverContent: { turnComplete: true } });
  await settle();
  await settle();
  assert.ok(startInput, "accepted handoff must still enter transfer start lifecycle");
  assert.equal(session.snapshot().closed, true);
});
