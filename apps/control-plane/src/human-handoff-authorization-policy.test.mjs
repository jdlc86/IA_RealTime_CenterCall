import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeHumanHandoff,
  initialHumanHandoffAuthorizationState,
  isExplicitHumanHandoffRejection,
  observeHumanHandoffCallerTurn,
} from "../.test-dist/human-handoff-authorization-policy.js";

test("model limitation cannot authorize terminal handoff by itself", () => {
  const initial = initialHumanHandoffAuthorizationState();
  const blocked = authorizeHumanHandoff(initial, "Vale, entendido.");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.source, "OFFER_REQUIRED");
  assert.equal(blocked.state.offerPending, true);
});

test("caller can explicitly request a human in the current turn", () => {
  const decision = authorizeHumanHandoff(initialHumanHandoffAuthorizationState(), "Quiero hablar con una persona del equipo");
  assert.equal(decision.allowed, true);
  assert.equal(decision.source, "EXPLICIT_REQUEST");
});

test("caller can accept a previously offered transfer", () => {
  const blocked = authorizeHumanHandoff(initialHumanHandoffAuthorizationState(), "Eso no me lo puedes resolver");
  assert.equal(blocked.allowed, false);
  const observed = observeHumanHandoffCallerTurn(blocked.state, "Sí");
  const confirmed = authorizeHumanHandoff(observed, "Sí");
  assert.equal(confirmed.allowed, true);
  assert.equal(confirmed.source, "CONFIRMED_OFFER");
});

test("natural confirmation wording must not consume a pending offer before tool authority resolves it", () => {
  const blocked = authorizeHumanHandoff(initialHumanHandoffAuthorizationState(), "Eso no me lo puedes resolver");
  assert.equal(blocked.state.offerPending, true);

  const observed = observeHumanHandoffCallerTurn(blocked.state, "Sí, por favor, pásame con ellos.");
  assert.equal(observed.offerPending, true);

  const confirmed = authorizeHumanHandoff(observed, "Sí, por favor, pásame con ellos.");
  assert.equal(confirmed.allowed, true);
  assert.ok(["CONFIRMED_OFFER", "EXPLICIT_REQUEST"].includes(confirmed.source));
});

test("fragmented or ambiguous caller wording must not silently consume a pending offer", () => {
  const blocked = authorizeHumanHandoff(initialHumanHandoffAuthorizationState(), "Eso no me lo puedes resolver");
  const fragment = observeHumanHandoffCallerTurn(blocked.state, "Sí, un momento...");
  assert.equal(fragment.offerPending, true);
});

test("caller rejection clears pending authorization", () => {
  const blocked = authorizeHumanHandoff(initialHumanHandoffAuthorizationState(), "Eso no me lo puedes resolver");
  const observed = observeHumanHandoffCallerTurn(blocked.state, "No, gracias");
  const rejected = authorizeHumanHandoff(observed, "No, gracias");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.source, "CALLER_REJECTED");
  assert.equal(rejected.state.offerPending, false);
});

test("emphatic repeated no is an explicit transfer rejection", () => {
  assert.equal(isExplicitHumanHandoffRejection("no no no"), true);
  assert.equal(isExplicitHumanHandoffRejection("nononono"), true);
  const rejected = authorizeHumanHandoff({ offerPending: true }, "no no no");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.source, "CALLER_REJECTED");
  assert.equal(rejected.state.offerPending, false);
});

test("pending offer is not expired merely by transcript observation", () => {
  const blocked = authorizeHumanHandoff(initialHumanHandoffAuthorizationState(), "Eso no me lo puedes resolver");
  const observed = observeHumanHandoffCallerTurn(blocked.state, "Otra cosa, ¿tenéis terraza?");
  assert.equal(observed.offerPending, true);
});
