import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPostBookingConversationPolicy } from "../.test-dist/post-booking-conversation-policy.js";

test("BOOKED response becomes proactive and forbids deferred offers language", () => {
  const input = "La reserva está confirmada por el backend. Comunícalo de forma breve.";
  const output = applyPostBookingConversationPolicy(input);
  assert.match(output, /¿Puedo ayudarte con algo más\?/);
  assert.match(output, /No anuncies que hablarás de ofertas o promociones más tarde/);
});

test("marketing result also returns control to the caller proactively", () => {
  const input = "Responde de forma breve usando únicamente este resultado autorizado de preferencias comerciales: {}";
  const output = applyPostBookingConversationPolicy(input);
  assert.match(output, /¿Puedo ayudarte con algo más\?/);
});

test("unrelated responses are unchanged", () => {
  const input = "Pregunta a qué hora desea reservar.";
  assert.equal(applyPostBookingConversationPolicy(input), input);
});
