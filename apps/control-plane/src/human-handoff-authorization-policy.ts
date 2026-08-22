import { isExplicitHumanHandoffRequest } from "./human-handoff-request-policy.js";

export type HumanHandoffAuthorizationState = {
  offerPending: boolean;
};

export type HumanHandoffAuthorizationDecision =
  | { allowed: true; source: "EXPLICIT_REQUEST" | "CONFIRMED_OFFER"; state: HumanHandoffAuthorizationState }
  | { allowed: false; source: "OFFER_REQUIRED" | "CALLER_REJECTED"; state: HumanHandoffAuthorizationState };

export function initialHumanHandoffAuthorizationState(): HumanHandoffAuthorizationState {
  return { offerPending: false };
}

function normalize(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
    : "";
}

function canonicalShortReply(value: unknown): string {
  return normalize(value).replace(/[.,;:!?¿¡]+/g, " ").replace(/\s+/g, " ").trim();
}

function isOfferAffirmative(value: unknown): boolean {
  const text = canonicalShortReply(value);
  return /^(?:si(?: por favor)?|vale|de acuerdo|adelante|hazlo|perfecto|claro(?: que si)?|por supuesto)$/.test(text);
}

export function isExplicitHumanHandoffRejection(value: unknown): boolean {
  const text = canonicalShortReply(value);
  return /^(?:(?:no)(?: no){0,5}|(?:no){2,6}|no gracias|mejor no|prefiero que no|dejalo|dejalo asi)$/.test(text);
}

/**
 * Transcript arrival is evidence about what the caller said, not evidence that
 * the caller changed semantic task. In particular, ASR may fragment or expand a
 * natural transfer confirmation. Therefore observing a caller transcript must
 * not silently consume a pending offer. Explicit rejection is the only safe
 * transcript-local terminal decision.
 */
export function observeHumanHandoffCallerTurn(
  state: HumanHandoffAuthorizationState,
  transcript: unknown,
): HumanHandoffAuthorizationState {
  if (!state.offerPending) return state;
  if (isExplicitHumanHandoffRejection(transcript)) return { offerPending: false };
  return state;
}

/**
 * A competing semantic business action is structural evidence that the caller
 * moved on from the transfer offer. This prevents a much later generic "sí"
 * from authorizing a stale handoff without relying on transcript keyword lists.
 */
export function clearHumanHandoffOfferForCompetingAction(
  state: HumanHandoffAuthorizationState,
): HumanHandoffAuthorizationState {
  return state.offerPending ? { offerPending: false } : state;
}

/**
 * Terminal human handoff requires caller authority.
 *
 * The model may identify that human assistance would be useful, but that alone
 * cannot authorize the irreversible transfer. A transfer is allowed only when
 * the current caller turn explicitly requests a human, or when the caller
 * explicitly accepts a transfer that was offered after a previous blocked
 * handoff attempt.
 */
export function authorizeHumanHandoff(
  state: HumanHandoffAuthorizationState,
  currentTranscript: unknown,
): HumanHandoffAuthorizationDecision {
  if (isExplicitHumanHandoffRejection(currentTranscript)) {
    return { allowed: false, source: "CALLER_REJECTED", state: { offerPending: false } };
  }

  if (isExplicitHumanHandoffRequest(currentTranscript)) {
    return { allowed: true, source: "EXPLICIT_REQUEST", state: { offerPending: false } };
  }

  if (state.offerPending && isOfferAffirmative(currentTranscript)) {
    return { allowed: true, source: "CONFIRMED_OFFER", state: { offerPending: false } };
  }

  return { allowed: false, source: "OFFER_REQUIRED", state: { offerPending: true } };
}
