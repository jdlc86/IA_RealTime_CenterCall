import test from "node:test";
import assert from "node:assert/strict";

// Contract tests for the v39 rebuild. These intentionally describe the
// architecture we require before any new lifecycle implementation is wired in.

const explicitHumanRequest = /\b(?:persona|humano|humana|agente|operador|operadora|empleado|empleada|equipo|responsable|encargado|encargada)\b/i;

function mayStartHumanHandoff(lastUserTranscript) {
  const text = String(lastUserTranscript ?? "").trim();
  return text.length > 0 && explicitHumanRequest.test(text);
}

function nextResponseAction({ activeResponse, interruptionClassified }) {
  if (!interruptionClassified) return "ignore";
  if (activeResponse) return "cancel_active_only";
  return "create_response";
}

function terminalTimers({ closing, hangupStarted, hangupCompleted }) {
  return closing || hangupStarted || hangupCompleted ? "cancel_all" : "keep";
}

test("handoff cannot be initiated from an ordinary restaurant question", () => {
  assert.equal(mayStartHumanHandoff("¿Qué tenéis en el menú?"), false);
  assert.equal(mayStartHumanHandoff("Quiero hacer una reserva"), false);
});

test("handoff requires explicit user evidence", () => {
  assert.equal(mayStartHumanHandoff("Pásame con una persona"), true);
  assert.equal(mayStartHumanHandoff("Quiero hablar con un agente"), true);
});

test("a confirmed interruption never creates a second concurrent response", () => {
  assert.equal(nextResponseAction({ activeResponse: true, interruptionClassified: true }), "cancel_active_only");
  assert.equal(nextResponseAction({ activeResponse: false, interruptionClassified: true }), "create_response");
});

test("noise/background speech does not mutate response ownership", () => {
  assert.equal(nextResponseAction({ activeResponse: true, interruptionClassified: false }), "ignore");
});

test("terminal call lifecycle cancels every conversational timer", () => {
  assert.equal(terminalTimers({ closing: true, hangupStarted: false, hangupCompleted: false }), "cancel_all");
  assert.equal(terminalTimers({ closing: false, hangupStarted: true, hangupCompleted: false }), "cancel_all");
  assert.equal(terminalTimers({ closing: false, hangupStarted: false, hangupCompleted: true }), "cancel_all");
});
