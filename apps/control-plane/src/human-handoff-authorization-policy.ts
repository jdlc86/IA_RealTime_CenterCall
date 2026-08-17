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

function isShortAffirmative(value: unknown): boolean {
  const text = normalize(value).replace(/[.!?]+$/g, "").trim();
  return /^(?:si|vale|de acuerdo|adelante|hazlo|por favor|perfecto)$/.test(text);
}

function isExplicitRejection(value: unknown): boolean {
  const text = normalize(value).replace(/[.!?]+$/g, "").trim();
  return /^(?:no|no gracias|mejor no|prefiero que no|dejalo|dejalo asi)$/.test(text);
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
  if (isExplicitHumanHandoffRequest(currentTranscript)) {
    return { allowed: true, source: "EXPLICIT_REQUEST", state: { offerPending: false } };
  }

  if (state.offerPending && isShortAffirmative(currentTranscript)) {
    return { allowed: true, source: "CONFIRMED_OFFER", state: { offerPending: false } };
  }

  if (isExplicitRejection(currentTranscript)) {
    return { allowed: false, source: "CALLER_REJECTED", state: { offerPending: false } };
  }

  return { allowed: false, source: "OFFER_REQUIRED", state: { offerPending: true } };
}
