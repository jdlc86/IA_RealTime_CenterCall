import type { CoreWorkflow } from "./core-intent-machine.js";

export type ClosingDecision =
  | { action: "ALLOW_CLOSE"; pending: false }
  | { action: "ASK_CONFIRMATION"; pending: true }
  | { action: "CONTINUE"; pending: false };

export type EndCallProposalDecision =
  | { action: "ALLOW_CLOSE" }
  | { action: "ASK_CONFIRMATION" }
  | { action: "ACK_PENDING" };

export type ControllerCloseSignal = "CLOSE" | "CONTINUE" | "COURTESY" | "UNRESOLVED";
export type CloseConsensusDecision =
  | { action: "CONSENSUS_CLOSE"; pending: false }
  | { action: "AMBIGUOUS_CONFIRM"; pending: true }
  | { action: "CONTINUE"; pending: false }
  | { action: "ACK_PENDING"; pending: true };

function normalizeClosingText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasExplicitContinueEvidence(value: string): boolean {
  const text = normalizeClosingText(value);
  return /\b(?:no|todavia no|aun no) (?:quiero )?(?:terminar|finalizar|colgar|que cuelgues|que cuelgue)\b/.test(text)
    || /\b(?:no cuelgues|no cuelgue|sigue|continua|continuemos)\b/.test(text);
}

function isCourtesyOnly(value: string): boolean {
  const text = normalizeClosingText(value);
  if (!text) return false;
  return /^(?:(?:vale|ok|perfecto|genial|muy bien)[ ,]*)?(?:muchas )?gracias(?: por (?:la )?(?:informacion|ayuda|atencion|respuesta))?$/.test(text);
}

/**
 * Deterministic strong evidence. It is intentionally not the sole closing
 * authority: v41 combines this controller signal with Lucia's semantic proposal.
 */
export function hasExplicitUserFarewellEvidence(value: string): boolean {
  const text = normalizeClosingText(value);
  if (!text || hasExplicitContinueEvidence(text)) return false;

  const strongFarewell = /(?:^|\b)(?:adios|hasta luego|hasta pronto|me despido|que tengas buen dia|que tenga buen dia)(?:\b|$)/.test(text);
  const explicitHangup = /(?:^|\b)(?:puedes colgar|puede colgar|podemos colgar|cuelga|cuelgue)(?:\b|$)/.test(text);
  const explicitCallEnd = /(?:^|\b)(?:termina|termine|finaliza|finalice) (?:ya )?(?:la )?llamada(?:\b|$)/.test(text)
    || /(?:^|\b)quiero (?:terminar|finalizar) (?:ya )?(?:la )?llamada(?:\b|$)/.test(text);

  if (strongFarewell || explicitHangup || explicitCallEnd) return true;

  return /(?:^|\b)(?:eso es todo|nada mas|no necesito nada mas|ya esta|hemos terminado|ya hemos terminado)(?: gracias| muchas gracias)?$/.test(text);
}

/** Independent controller interpretation of the caller turn. */
export function classifyControllerCloseSignal(value: string): ControllerCloseSignal {
  if (hasExplicitContinueEvidence(value)) return "CONTINUE";
  if (hasExplicitUserFarewellEvidence(value)) return "CLOSE";
  if (isCourtesyOnly(value)) return "COURTESY";
  return "UNRESOLVED";
}

export function isExplicitClosingConfirmation(value: string): boolean {
  const text = normalizeClosingText(value);
  return /^(?:si|si claro|claro|de acuerdo|vale|ok|correcto|confirmo)(?:\b|$)/.test(text);
}

export function isExplicitClosingRejection(value: string): boolean {
  const text = normalizeClosingText(value);
  return /^(?:no|no gracias|todavia no|aun no|mejor no)(?:\b|$)/.test(text);
}

export function shouldCommitPendingClose(
  closingConfirmationPending: boolean,
  transcript: string,
): boolean {
  return closingConfirmationPending && isExplicitClosingConfirmation(transcript);
}

/**
 * Consensus policy. Lucia expresses CLOSE by selecting restaurant_end_call.
 * The controller independently classifies the caller's latest turn. Neither
 * side vetoes the other: agreement closes; disagreement or insufficient
 * evidence becomes AMBIGUOUS_CONFIRM and is resolved by the caller.
 */
export function decideCloseConsensus(
  confirmationPending: boolean,
  controllerSignal: ControllerCloseSignal,
  luciaProposesClose: boolean,
): CloseConsensusDecision {
  if (confirmationPending) return { action: "ACK_PENDING", pending: true };
  if (!luciaProposesClose) return { action: "CONTINUE", pending: false };
  if (controllerSignal === "CLOSE") return { action: "CONSENSUS_CLOSE", pending: false };
  return { action: "AMBIGUOUS_CONFIRM", pending: true };
}

/** Backward-compatible adapter retained for older tests/callers. */
export function decideEndCallProposal(
  closingConfirmationPending: boolean,
  userClosingEvidence: boolean,
  modelConfirmed: boolean,
): EndCallProposalDecision {
  const decision = decideCloseConsensus(
    closingConfirmationPending,
    userClosingEvidence ? "CLOSE" : "UNRESOLVED",
    modelConfirmed,
  );
  if (decision.action === "CONSENSUS_CLOSE") return { action: "ALLOW_CLOSE" };
  if (decision.action === "ACK_PENDING") return { action: "ACK_PENDING" };
  return { action: "ASK_CONFIRMATION" };
}

export function decideClosingTransition(
  _currentWorkflow: CoreWorkflow,
  requestedWorkflow: CoreWorkflow,
  closingPending: boolean,
  explicitClosingConfirmed = false,
): ClosingDecision {
  if (requestedWorkflow !== "CLOSING") return { action: "CONTINUE", pending: false };
  if (explicitClosingConfirmed || closingPending) return { action: "ALLOW_CLOSE", pending: false };
  return { action: "ASK_CONFIRMATION", pending: true };
}
