import { CallSession as CallSessionV11 } from "./call-session-v11";
import { reservationSpeechTruthState, applyReservationSpeechTruth } from "./reservation-speech-state";
import { withAuthoritativeTemporalGrounding } from "./temporal-grounding";
import { reservationRoutingRuntimeFor } from "./reservation-routing-runtime.js";

const BaseConstructor = CallSessionV11 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV11.prototype as any;

/**
 * v12 centralizes spoken-response truth at the session boundary. Upstream
 * workflows provide backend-authorized state and timestamps; this layer applies
 * reservation truth plus deterministic Europe/Madrid temporal grounding before
 * the model verbalizes anything.
 */
export class CallSession extends BaseConstructor {
  private createSpokenResponse(instructions: string): void {
    const routing = reservationRoutingRuntimeFor(this).snapshot();
    const reservationState = reservationSpeechTruthState({
      reservationBookedThisCall: (this as any).reservationBookedThisCall === true,
      reservationIntentActive: routing.createIntentActive,
      reservationDraft: (this as any).reservationDraft,
    });
    const truthBound = applyReservationSpeechTruth(instructions, reservationState);
    const grounded = withAuthoritativeTemporalGrounding(truthBound);

    (this as any).diagnostics?.checkpoint?.("RESERVATION_SPEECH_STATE_APPLIED", {
      state: reservationState,
      booked_evidence: (this as any).reservationBookedThisCall === true,
      reservation_intent_active: routing.createIntentActive,
    });
    (this as any).diagnostics?.checkpoint?.("TEMPORAL_GROUNDING_APPLIED", {
      applied: grounded !== truthBound,
      timezone: "Europe/Madrid",
    });
    BasePrototype.createSpokenResponse.call(this, grounded);
  }
}
