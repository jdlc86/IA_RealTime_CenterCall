import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_REALTIME_PROVIDER,
  adaptRealtimeProviderEvents,
  bindAdmittedRealtimeProvider,
  bindRealtimeProvider,
  installRealtimeToolResultObserver,
  installRealtimeToolResultPolicy,
  observeRealtimeAssistantResponseCompleted,
  observeRealtimeAssistantResponseStarted,
  realtimeCommandPortFor,
  realtimeProviderFor,
  stageConsolidatedCallerTurnForNextResponse,
} from "../.test-dist/realtime-provider-runtime.js";
import { authorizeRealtimeProviderTraffic } from "../.test-dist/realtime-provider-traffic-admission.js";
import { installExternalRealtimeProviderCommandPort } from "../.test-dist/realtime-provider-external-command-runtime.js";
import { decideDirectPostToolResponse } from "../.test-dist/post-booking-conversation-policy.js";

function host() {
  const events = [];
  return { events, send(event) { events.push(event); } };
}

function wire(event) { return JSON.stringify(event); }
function responseCreates(events) { return events.filter((event) => event?.type === "response.create"); }
function externalPort(overrides = {}) {
  return {
    speak() {}, requestTextDecision() {}, createSemanticResponse() {}, submitToolResult() {},
    updateSessionPolicy() {}, setSemanticToolGate() {}, createDefaultResponse() {}, cancelResponse() {},
    clearPlayback() {}, clearInput() {}, discardInputItem() {}, suspendInputDetection() {},
    beginNonInterruptingListening() {}, restoreInputDetection() {},
    ...overrides,
  };
}

test("provider runtime keeps OpenAI as the active traffic baseline during G1", () => {
  assert.equal(ACTIVE_REALTIME_PROVIDER, "OPENAI");
});

test("G1 binds the selected enabled provider before command runtime creation", () => {
  const h = host();
  bindRealtimeProvider(h, "OPENAI");
  assert.equal(realtimeProviderFor(h), "OPENAI");
  const port = realtimeCommandPortFor(h);
  port.speak({ instructions: "hola", tools: "DISABLED", purpose: "provider-selector-g1" });
  assert.equal(h.events[0]?.type, "response.create");
});

test("G1 rejects registered Gemini until its traffic gates are enabled", () => {
  const h = host();
  assert.throws(() => bindRealtimeProvider(h, "GEMINI"), /registered but not enabled for traffic/);
  assert.equal(realtimeProviderFor(h), "OPENAI");
});

test("an opaque exact-tenant admission binds Gemini without global enablement", () => {
  const h = host();
  const selection = {
    tenantId: "tenant-canary",
    provider: "GEMINI",
    source: "TENANT_CONFIG",
    overrideKey: "unused",
  };
  const admission = authorizeRealtimeProviderTraffic(selection, {
    environment: "production",
    geminiEnabled: "true",
    geminiCanaryTenantId: "tenant-canary",
  });
  const spoken = [];
  installExternalRealtimeProviderCommandPort(h, "GEMINI", { speak(request) { spoken.push(request); } });
  bindAdmittedRealtimeProvider(h, selection, admission);
  realtimeCommandPortFor(h).speak({ instructions: "hola", exactText: "Hola" });
  assert.equal(realtimeProviderFor(h), "GEMINI");
  assert.deepEqual(spoken, [{ instructions: "hola", exactText: "Hola" }]);
});

test("Gemini deterministic replacement bypasses FunctionResponse while OpenAI wire remains unchanged", () => {
  const gemini = host();
  const selection = {
    tenantId: "tenant-canary",
    provider: "GEMINI",
    source: "TENANT_CONFIG",
    overrideKey: "unused",
  };
  const admission = authorizeRealtimeProviderTraffic(selection, {
    environment: "production",
    geminiEnabled: "true",
    geminiCanaryTenantId: "tenant-canary",
  });
  const effects = [];
  installExternalRealtimeProviderCommandPort(gemini, "GEMINI", externalPort({
    speak(request) { effects.push({ type: "speak", request }); },
    submitToolResult(request) { effects.push({ type: "tool_result", request }); },
    createDefaultResponse() { effects.push({ type: "generation" }); },
    bypassDeterministicToolContinuation(request, context) { effects.push({ type: "bypass", request, context }); },
  }));
  bindAdmittedRealtimeProvider(gemini, selection, admission);
  installRealtimeToolResultPolicy(gemini, () => ({
    action: "REPLACE_DEFAULT_RESPONSE",
    speech: { instructions: "OpenAI conserva la generación actual." },
    geminiDeterministic: {
      speech: { instructions: "Pregunta exacta.", exactText: "¿A qué nombre hago la reserva?" },
      continuationContext: "RESERVATION_CUSTOMER_NAME",
    },
  }));
  observeRealtimeAssistantResponseStarted(gemini, "gemini-response-1");
  const geminiPort = realtimeCommandPortFor(gemini);
  const toolResult = {
    callId: "fc-real-1",
    toolName: "restaurant_reservation_create",
    output: { ok: true, status: "AVAILABLE_NEEDS_CONTACT" },
  };
  geminiPort.submitToolResult(toolResult);
  geminiPort.createDefaultResponse();
  assert.deepEqual(effects, [{
    type: "bypass",
    request: toolResult,
    context: "RESERVATION_CUSTOMER_NAME",
  }]);
  observeRealtimeAssistantResponseCompleted(gemini, "gemini-response-1");
  assert.deepEqual(effects.at(-1), {
    type: "speak",
    request: { instructions: "Pregunta exacta.", exactText: "¿A qué nombre hago la reserva?" },
  });
  assert.equal(effects.some((effect) => effect.type === "tool_result" || effect.type === "generation"), false);

  const openai = host();
  installRealtimeToolResultPolicy(openai, () => ({
    action: "REPLACE_DEFAULT_RESPONSE",
    speech: { instructions: "OpenAI conserva la generación actual." },
    geminiDeterministic: {
      speech: { instructions: "Pregunta exacta.", exactText: "No debe usarse en OpenAI." },
      continuationContext: "RESERVATION_CUSTOMER_NAME",
    },
  }));
  const openaiPort = realtimeCommandPortFor(openai);
  openaiPort.submitToolResult(toolResult);
  openaiPort.createDefaultResponse();
  assert.equal(openai.events[0]?.type, "conversation.item.create");
  assert.equal(openai.events[1]?.type, "response.create");
  assert.equal(openai.events[1]?.response?.instructions, "OpenAI conserva la generación actual.");
});

test("G1 provider binding is immutable even before command runtime creation", () => {
  const h = host();
  bindRealtimeProvider(h, "OPENAI");
  assert.throws(() => bindRealtimeProvider(h, "GEMINI"), /already bound as OPENAI/);
  assert.equal(realtimeProviderFor(h), "OPENAI");
});

test("neutral command access preserves the existing OpenAI wire behavior", () => {
  const h = host();
  const port = realtimeCommandPortFor(h);
  port.speak({ instructions: "hola", tools: "DISABLED", purpose: "neutrality-gate" });

  assert.deepEqual(h.events, [{
    type: "response.create",
    response: {
      instructions: "hola",
      tool_choice: "none",
      metadata: { purpose: "neutrality-gate" },
    },
  }]);
});

test("neutral tool-result observers receive structured results before provider translation", () => {
  const h = host();
  const observed = [];
  installRealtimeToolResultObserver(h, (request) => observed.push(request));
  const port = realtimeCommandPortFor(h);
  const request = {
    callId: "call-business-info",
    toolName: "restaurant_business_info",
    output: { ok: true, status: "FOUND" },
  };

  port.submitToolResult(request);

  assert.deepEqual(observed, [request]);
  assert.deepEqual(h.events, [{
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: "call-business-info",
      output: '{"ok":true,"status":"FOUND"}',
    },
  }]);
});

test("neutral tool-result policy can replace only the following default response", () => {
  const h = host();
  installRealtimeToolResultPolicy(h, (request) => {
    if (request.callId !== "call-terminal") return { action: "PASS" };
    return {
      action: "REPLACE_DEFAULT_RESPONSE",
      speech: {
        instructions: "resultado gobernado",
        tools: "DISABLED",
        purpose: "direct_post_tool_terminal_v26",
      },
    };
  });
  const port = realtimeCommandPortFor(h);

  port.submitToolResult({ callId: "call-terminal", output: { ok: true, status: "FOUND" } });
  port.createDefaultResponse();

  assert.deepEqual(h.events, [
    {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-terminal",
        output: '{"ok":true,"status":"FOUND"}',
      },
    },
    {
      type: "response.create",
      response: {
        instructions: "resultado gobernado",
        tool_choice: "none",
        metadata: { purpose: "direct_post_tool_terminal_v26" },
      },
    },
  ]);
});

test("governed post-tool speech is deferred while its selecting response is active", () => {
  const h = host();
  installRealtimeToolResultPolicy(h, () => ({
    action: "REPLACE_DEFAULT_RESPONSE",
    speech: {
      instructions: "pregunta la hora",
      tools: "DISABLED",
      purpose: "reservation_missing_information_v26",
    },
  }));
  const port = realtimeCommandPortFor(h);

  observeRealtimeAssistantResponseStarted(h, "response-tool-a");
  port.submitToolResult({
    callId: "call-missing-time",
    toolName: "restaurant_reservation_create",
    output: { ok: true, status: "MISSING_INFORMATION", missing: ["starts_at_time"] },
  });
  port.createDefaultResponse();

  assert.equal(responseCreates(h.events).length, 0);

  observeRealtimeAssistantResponseCompleted(h, "response-tool-a");

  const created = responseCreates(h.events);
  assert.equal(created.length, 1);
  assert.equal(created[0]?.response?.instructions, "pregunta la hora");
  assert.equal(created[0]?.response?.metadata?.purpose, "reservation_missing_information_v26");
});

test("stale response completion cannot release governed speech while a newer response is active", () => {
  const h = host();
  installRealtimeToolResultPolicy(h, () => ({
    action: "REPLACE_DEFAULT_RESPONSE",
    speech: {
      instructions: "pregunta la hora",
      tools: "DISABLED",
      purpose: "reservation_missing_information_v26",
    },
  }));
  const port = realtimeCommandPortFor(h);

  observeRealtimeAssistantResponseStarted(h, "response-a");
  port.submitToolResult({
    callId: "call-missing-time",
    toolName: "restaurant_reservation_create",
    output: { ok: true, status: "MISSING_INFORMATION", missing: ["starts_at_time"] },
  });
  port.createDefaultResponse();
  assert.equal(responseCreates(h.events).length, 0);

  observeRealtimeAssistantResponseStarted(h, "response-b");
  observeRealtimeAssistantResponseCompleted(h, "response-a");
  assert.equal(responseCreates(h.events).length, 0);

  observeRealtimeAssistantResponseCompleted(h, "response-b");
  const created = responseCreates(h.events);
  assert.equal(created.length, 1);
  assert.equal(created[0]?.response?.metadata?.purpose, "reservation_missing_information_v26");

  observeRealtimeAssistantResponseCompleted(h, "response-b");
  assert.equal(responseCreates(h.events).length, 1);
});

test("production-shaped duplicate rejection resumes with tools disabled after the selecting response completes", () => {
  const h = host();
  installRealtimeToolResultPolicy(h, (request) => {
    const decision = decideDirectPostToolResponse(request.toolName ?? "", request.output);
    if (decision.action !== "CONTINUE") return { action: "PASS" };
    return {
      action: "REPLACE_DEFAULT_RESPONSE",
      speech: {
        instructions: decision.instructions,
        tools: "DISABLED",
        purpose: "duplicate_semantic_continuation_v26",
      },
    };
  });
  const port = realtimeCommandPortFor(h);

  observeRealtimeAssistantResponseStarted(h, "response-duplicate-tool");
  port.submitToolResult({
    callId: "call-duplicate-cancel",
    toolName: "restaurant_reservation_cancel",
    output: {
      ok: false,
      status: "REJECTED",
      reason: "DUPLICATE_SEMANTIC_DECISION",
      authoritative_tool: "restaurant_reservation_cancel",
    },
  });
  port.createDefaultResponse();

  assert.equal(responseCreates(h.events).length, 0);
  observeRealtimeAssistantResponseCompleted(h, "response-duplicate-tool");

  const created = responseCreates(h.events);
  assert.equal(created.length, 1);
  assert.equal(created[0]?.response?.tool_choice, "none");
  assert.equal(created[0]?.response?.metadata?.purpose, "duplicate_semantic_continuation_v26");
  assert.match(created[0]?.response?.instructions ?? "", /resultado autorizado anterior/i);
});

test("normal default response is deferred and coalesced while another response is active", () => {
  const h = host();
  const port = realtimeCommandPortFor(h);

  observeRealtimeAssistantResponseStarted(h, "response-active");
  port.createDefaultResponse();
  port.createDefaultResponse();
  assert.equal(responseCreates(h.events).length, 0);

  observeRealtimeAssistantResponseCompleted(h, "response-active");
  assert.deepEqual(responseCreates(h.events), [{ type: "response.create" }]);
});

test("staged semantic response waits for the active response to complete", () => {
  const h = host();
  const port = realtimeCommandPortFor(h);

  observeRealtimeAssistantResponseStarted(h, "response-active");
  stageConsolidatedCallerTurnForNextResponse(h, "sí, quiero continuar");
  port.createDefaultResponse();
  assert.equal(responseCreates(h.events).length, 0);

  observeRealtimeAssistantResponseCompleted(h, "response-active");
  const created = responseCreates(h.events);
  assert.equal(created.length, 1);
  assert.match(h.events[0]?.item?.content?.[0]?.text ?? "", /sí, quiero continuar$/);
  assert.equal(created[0]?.response?.metadata?.consolidated_caller_turn, "true");
});

test("governed replacement takes precedence over a deferred default response", () => {
  const h = host();
  installRealtimeToolResultPolicy(h, () => ({
    action: "REPLACE_DEFAULT_RESPONSE",
    speech: { instructions: "respuesta gobernada", purpose: "governed-precedence" },
  }));
  const port = realtimeCommandPortFor(h);

  observeRealtimeAssistantResponseStarted(h, "response-active");
  port.createDefaultResponse();
  port.submitToolResult({ callId: "call-governed", output: { ok: true } });
  port.createDefaultResponse();
  observeRealtimeAssistantResponseCompleted(h, "response-active");

  const created = responseCreates(h.events);
  assert.equal(created.length, 1);
  assert.equal(created[0]?.response?.instructions, "respuesta gobernada");
  assert.equal(created[0]?.response?.metadata?.purpose, "governed-precedence");
});

test("neutral tool-result policy preserves normal default response wire behavior", () => {
  const h = host();
  installRealtimeToolResultPolicy(h, () => ({ action: "PASS" }));
  const port = realtimeCommandPortFor(h);
  port.submitToolResult({ callId: "call-normal", output: { ok: true, status: "READY_TO_CONFIRM" } });
  port.createDefaultResponse();
  assert.deepEqual(h.events[1], { type: "response.create" });
});

test("a later tool result clears any earlier pending default-response replacement", () => {
  const h = host();
  installRealtimeToolResultPolicy(h, (request) => request.callId === "first"
    ? { action: "REPLACE_DEFAULT_RESPONSE", speech: { instructions: "replace" } }
    : { action: "PASS" });
  const port = realtimeCommandPortFor(h);
  port.submitToolResult({ callId: "first", output: { ok: true } });
  port.submitToolResult({ callId: "second", output: { ok: true } });
  port.createDefaultResponse();
  assert.deepEqual(h.events.at(-1), { type: "response.create" });
});

test("neutral event access delegates current OpenAI wire events without semantic change", () => {
  assert.deepEqual(
    adaptRealtimeProviderEvents(wire({ type: "input_audio_buffer.speech_started" })),
    [{ type: "CALLER_SPEECH_STARTED" }],
  );
});

test("neutral command access preserves one adapter instance per host", () => {
  const h = host();
  assert.equal(realtimeCommandPortFor(h), realtimeCommandPortFor(h));
  assert.notEqual(realtimeCommandPortFor(h), realtimeCommandPortFor(host()));
});
