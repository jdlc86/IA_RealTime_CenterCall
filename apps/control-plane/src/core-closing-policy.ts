import type { CoreWorkflow } from "./core-intent-machine.js";

export type ClosingDecision =
  | { action: "ALLOW_CLOSE"; pending: false }
  | { action: "ASK_CONFIRMATION"; pending: true }
  | { action: "CONTINUE"; pending: false };

export type EndCallProposalDecision =
  | { action: "ALLOW_CLOSE" }
  | { action: "ASK_CONFIRMATION" }
  | { action: "ACK_PENDING" };

function normalizeClosingText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strong farewell expressions remain evidence even when surrounded by natural
 * courtesy language. Vague completion expressions stay end-anchored so phrases
 * such as "no necesito nada más sobre la reserva, pero..." cannot close a call.
 */
export function hasExplicitUserFarewellEvidence(value: string): boolean {
  const text = normalizeClosingText(value);
  if (!text) return false;

  const strongFarewell = /(?:^|\b)(?:adios|hasta luego|hasta pronto|me despido)(?:\b|$)/.test(text);
  const explicitHangup = /(?:^|\b)(?:puedes colgar|puede colgar|podemos colgar|cuelga|cuelgue)(?:\b|$)/.test(text);
  const explicitCallEnd = /(?:^|\b)(?:termina|termine|finaliza|finalice) (?:ya )?(?:la )?llamada(?:\b|$)/.test(text)
    || /(?:^|\b)quiero (?:terminar|finalizar) (?:ya )?(?:la )?llamada(?:\b|$)/.test(text);

  if (strongFarewell || explicitHangup || explicitCallEnd) {
    // Explicit negation must win over a matching phrase.
    if (/\b(?:no|todavia no|aun no) (?:quiero )?(?:terminar|finalizar|colgar|cuelgues|cuelgue)\b/.test(text)) return false;
    if (/\b(?:no|todavia no|aun no) (?:me despido|adios|hasta luego|hasta pronto)\b/.test(text)) return false;
    return true;
  }

  // These are intentionally terminal-only because they can also close a topic,
  // not necessarily the phone call, when followed by another request.
  return /(?:^|\b)(?:eso es todo|nada mas|no necesito nada mas|ya esta|hemos terminado|ya hemos terminado)(?: gracias| muchas gracias)?$/.test(text);
}

export function isExplicitClosingConfirmation(value: string): boolean {
  const text = normalizeClosingText(value);
  return /^(?:si|si claro|claro|de acuerdo|vale|ok|correcto|confirmo)(?:\b|$)/.test(text);
}

export function shouldCommitPendingClose(
  closingConfirmationPending: boolean,
  transcript: string,
): boolean {
  return closingConfirmationPending && isExplicitClosingConfirmation(transcript);
}

/**
 * Backend authority for restaurant_end_call.
 *
 * Once a confirmation question is pending, repeated model proposals are merely
 * acknowledged. They must not create another assistant response because only a
 * new caller turn may resolve or replace the pending decision.
 */
export function decideEndCallProposal(
  closingConfirmationPending: boolean,
  userClosingEvidence: boolean,
  modelConfirmed: boolean,
): EndCallProposalDecision {
  if (closingConfirmationPending) return { action: "ACK_PENDING" };
  if (!modelConfirmed || !userClosingEvidence) return { action: "ASK_CONFIRMATION" };
  return { action: "ALLOW_CLOSE" };
}

export function decideClosingTransition(
  _currentWorkflow: CoreWorkflow,
  requestedWorkflow: CoreWorkflow,
  closingPending: boolean,
  explicitClosingConfirmed = false,
): ClosingDecision {
  if (requestedWorkflow !== "CLOSING") {
    return { action: "CONTINUE", pending: false };
  }

  if (explicitClosingConfirmed || closingPending) {
    return { action: "ALLOW_CLOSE", pending: false };
  }

  return { action: "ASK_CONFIRMATION", pending: true };
}
