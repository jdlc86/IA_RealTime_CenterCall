import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTerminalConversationPolicy } from "../.test-dist/post-booking-conversation-policy.js";

const EXPECTED_FOLLOW_UP = /¿Necesitas algo más en lo que pueda ayudarte\?/;

test("BOOKED response becomes proactive and forbids deferred offers language", () => {
  const input = "La reserva está confirmada por el backend. Comunícalo de forma breve.";
  const output = applyTerminalConversationPolicy(input);
  assert.match(output, EXPECTED_FOLLOW_UP);
  assert.match(output, /No dejes la llamada abierta en silencio/);
  assert.match(output, /No anuncies que hablarás de ofertas o promociones más tarde/);
});

test("marketing result also returns control to the caller proactively", () => {
  const input = "Responde de forma breve usando únicamente este resultado autorizado de preferencias comerciales: {}";
  const output = applyTerminalConversationPolicy(input);
  assert.match(output, EXPECTED_FOLLOW_UP);
});

test("completed cancellation always returns control to the caller", () => {
  const input = "Usa únicamente este resultado autorizado de cancelación: [{\"reservation_code\":\"R-100016\",\"status\":\"CANCELLED\"}]";
  const output = applyTerminalConversationPolicy(input);
  assert.match(output, EXPECTED_FOLLOW_UP);
  assert.match(output, /no esperes a que el usuario hable/i);
});

test("empty reservation query remains proactive", () => {
  const input = "Indica que no has encontrado reservas futuras confirmadas asociadas al mismo número desde el que está llamando.";
  assert.match(applyTerminalConversationPolicy(input), EXPECTED_FOLLOW_UP);
});

test("reservation query with results remains proactive", () => {
  const input = "Informa de las reservas futuras confirmadas asociadas a esta llamada usando únicamente estos resultados verificados: []";
  assert.match(applyTerminalConversationPolicy(input), EXPECTED_FOLLOW_UP);
});

test("non-terminal workflow prompts are unchanged", () => {
  const input = "Pregunta a qué hora desea reservar.";
  assert.equal(applyTerminalConversationPolicy(input), input);
});
