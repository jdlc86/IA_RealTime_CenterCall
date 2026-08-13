import assert from "node:assert/strict";
import { test } from "node:test";
import { applyReservationSpeechTruth, reservationSpeechTruthState } from "../.test-dist/reservation-speech-state.js";

test("active CREATE intent is pending even before draft fields exist", () => {
  assert.equal(reservationSpeechTruthState({
    reservationBookedThisCall: false,
    reservationIntentActive: true,
    reservationDraft: {},
  }), "PENDING_NOT_BOOKED");
});

test("non-empty reservation draft is pending without BOOKED evidence", () => {
  assert.equal(reservationSpeechTruthState({
    reservationBookedThisCall: false,
    reservationIntentActive: false,
    reservationDraft: { partySize: 2 },
  }), "PENDING_NOT_BOOKED");
});

test("BOOKED backend evidence is the only state that authorizes confirmation", () => {
  assert.equal(reservationSpeechTruthState({
    reservationBookedThisCall: true,
    reservationIntentActive: true,
    reservationDraft: { partySize: 2 },
  }), "BOOKED");
});

test("pending state injects an explicit prohibition against false booking claims", () => {
  const output = applyReservationSpeechTruth("Pregunta el nombre.", "PENDING_NOT_BOOKED");
  assert.match(output, /PENDING_NOT_BOOKED/);
  assert.match(output, /No existe evidencia BOOKED/);
  assert.match(output, /prohibido afirmar o insinuar/);
});

test("unrelated speech is unchanged when no CREATE workflow is active", () => {
  assert.equal(applyReservationSpeechTruth("Explica el horario.", "NO_ACTIVE_CREATE"), "Explica el horario.");
});
