import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTINUATION_QUESTION,
  RESERVATION_AVAILABILITY_CHANGED_SPEECH,
  applyTerminalConversationPolicy,
  decideDirectPostToolResponse,
} from "../.test-dist/post-booking-conversation-policy.js";

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

test("direct post-tool BOOKED without marketing enforces exact continuation", () => {
  const decision = decideDirectPostToolResponse("restaurant_reservation_create", {
    ok: true,
    stage: "BOOKED",
    ask_marketing_consent: false,
  });
  assert.equal(decision.action, "GOVERN");
  if (decision.action !== "GOVERN") return;
  assert.equal(decision.reason, "BOOKED");
  assert.match(decision.instructions, new RegExp(CONTINUATION_QUESTION.replace(/[?]/g, "\\?")));
  assert.match(decision.instructions, /pregunta exactamente/i);
  assert.match(decision.instructions, /No añadas ninguna otra pregunta/i);
});

test("direct post-tool BOOKED with marketing pending preserves the marketing subflow", () => {
  assert.deepEqual(
    decideDirectPostToolResponse("restaurant_reservation_create", {
      ok: true,
      stage: "BOOKED",
      ask_marketing_consent: true,
    }),
    { action: "DEFAULT", reason: "MARKETING_CONSENT_PENDING" },
  );
});

test("commit-time availability conflict has deterministic caller recovery and no same-response search", () => {
  const decision = decideDirectPostToolResponse("restaurant_reservation_create", {
    ok: true,
    status: "AVAILABILITY_CHANGED",
    stage: "AVAILABILITY_CHANGED",
    reservation_created: false,
    requires_new_confirmation: true,
  });
  assert.equal(decision.action, "RECOVER");
  if (decision.action !== "RECOVER") return;
  assert.equal(decision.reason, "RESERVATION_AVAILABILITY_CHANGED");
  assert.equal(decision.exactText, RESERVATION_AVAILABILITY_CHANGED_SPEECH);
  assert.match(decision.exactText, /no se ha creado ninguna reserva/i);
  assert.match(decision.exactText, /horarios cercanos/i);
  assert.match(decision.instructions, /No llames herramientas en esta misma respuesta/i);
  assert.match(decision.instructions, /restaurant_reservation_search/i);
  assert.match(decision.instructions, /confirmación explícita nueva/i);
});

test("reservation MISSING_INFORMATION must yield one governed caller question instead of another tool", () => {
  const decision = decideDirectPostToolResponse("restaurant_reservation_create", {
    ok: true,
    status: "MISSING_INFORMATION",
    missing: ["starts_at"],
    draft: { party_size: 5 },
  });
  assert.equal(decision.action, "COLLECT");
  if (decision.action !== "COLLECT") return;
  assert.equal(decision.reason, "RESERVATION_MISSING_INFORMATION");
  assert.deepEqual(decision.missing, ["starts_at"]);
  assert.match(decision.instructions, /día/i);
  assert.match(decision.instructions, /hora/i);
  assert.match(decision.instructions, /No llames herramientas/i);
});

test("reservation missing-field recovery remains structural for multiple fields", () => {
  const decision = decideDirectPostToolResponse("restaurant_reservation_create", {
    ok: true,
    status: "MISSING_INFORMATION",
    missing: ["customer_name", "customer_phone"],
    draft: { party_size: 5, starts_at: "2026-08-22T21:00:00+02:00" },
  });
  assert.equal(decision.action, "COLLECT");
  if (decision.action !== "COLLECT") return;
  assert.deepEqual(decision.missing, ["customer_name", "customer_phone"]);
  assert.match(decision.instructions, /nombre/i);
  assert.match(decision.instructions, /tel[eé]fono/i);
  assert.doesNotMatch(decision.instructions, /restaurant_reservation_search/i);
});

test("malformed availability conflict evidence is not promoted to deterministic recovery", () => {
  assert.deepEqual(
    decideDirectPostToolResponse("restaurant_reservation_create", {
      ok: true,
      stage: "AVAILABILITY_CHANGED",
      reservation_created: false,
      requires_new_confirmation: false,
    }),
    { action: "DEFAULT", reason: "NON_TERMINAL" },
  );
});

test("direct marketing completion deterministically returns to more-help question", () => {
  const decision = decideDirectPostToolResponse("restaurant_marketing_preferences", {
    ok: true,
    status: "MARKETING_UPDATED",
    action: "DECLINE",
    preference_status: "DECLINED",
  });
  assert.equal(decision.action, "GOVERN");
  if (decision.action !== "GOVERN") return;
  assert.equal(decision.reason, "MARKETING_COMPLETED");
  assert.match(decision.instructions, EXPECTED_FOLLOW_UP);
});

test("direct non-terminal confirmation state remains model-driven", () => {
  assert.deepEqual(
    decideDirectPostToolResponse("restaurant_marketing_preferences", {
      ok: true,
      status: "EXPLICIT_DECISION_REQUIRED",
    }),
    { action: "DEFAULT", reason: "NON_TERMINAL" },
  );
  assert.deepEqual(
    decideDirectPostToolResponse("restaurant_reservation_create", {
      ok: true,
      status: "READY_TO_CONFIRM",
    }),
    { action: "DEFAULT", reason: "NON_TERMINAL" },
  );
});

test("direct query, cancellation, modification and business-info terminal results are governed", () => {
  const cases = [
    ["restaurant_reservation_query", { ok: true, status: "FOUND" }],
    ["restaurant_reservation_query", { ok: true, status: "NONE" }],
    ["restaurant_reservation_cancel", { ok: true, status: "CANCELLED" }],
    ["restaurant_reservation_cancel", { ok: true, status: "NO_RESERVATIONS" }],
    ["restaurant_reservation_cancel", { ok: false, status: "PARTIAL_FAILURE" }],
    ["restaurant_reservation_modify", { ok: true, status: "MODIFIED" }],
    ["restaurant_business_info", { ok: true, status: "FOUND" }],
  ];
  for (const [tool, output] of cases) {
    const decision = decideDirectPostToolResponse(tool, output);
    assert.equal(decision.action, "GOVERN", `${tool} should be governed`);
  }
});
