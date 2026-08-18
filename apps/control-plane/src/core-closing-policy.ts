import type { CoreWorkflow } from "./core-intent-machine.js";

export type ClosingDecision =
  | { action: "ALLOW_CLOSE"; pending: false }
  | { action: "ASK_CONFIRMATION"; pending: true }
  | { action: "CONTINUE"; pending: false };

export type EndCallProposalDecision =
  | { action: "ALLOW_CLOSE" }
  | { action: "ASK_CONFIRMATION" }
  | { action: "ACK_PENDING" };

export type ControllerCloseIntent = "CLOSE" | "CONTINUE" | "ABSTAIN";
export type ControllerCloseAssessment = {
  courtesy: boolean;
  closeIntent: ControllerCloseIntent;
};

export type CloseConsensusDecision =
  | { action: "CONSENSUS_CLOSE"; pending: false }
  | { action: "COURTESY_FOLLOWUP"; pending: false }
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

function hasFollowupRequestAfterCompletion(value: string): boolean {
  const text = normalizeClosingText(value);
  const completion = /\b(?:no necesito nada mas|no necesito mas nada|eso es todo|nada mas|ya esta|hemos terminado|ya hemos terminado)\b/.test(text);
  if (!completion) return false;
  return /\b(?:pero|aunque|ahora|ademas|tambien)\b.*\b(?:dime|cuentame|quiero|necesito|puedes|podrias|quisiera|preguntar|saber|consultar)\b/.test(text)
    || /\b(?:pero|ahora|ademas|tambien)\b.*\b(?:menu|horario|reserva|reservas|direccion|precio|precios|telefono)\b/.test(text);
}

function hasCourtesyEvidence(value: string): boolean {
  const text = normalizeClosingText(value);
  if (!text) return false;
  return /\b(?:gracias|muchas gracias|te lo agradezco|se lo agradezco|muy amable)\b/.test(text);
}

/**
 * Deterministic strong close evidence. Courtesy may coexist with closing intent:
 * "muchas gracias, no necesito nada más" is both courteous and clearly closing.
 */
export function hasExplicitUserFarewellEvidence(value: string): boolean {
  const text = normalizeClosingText(value);
  if (!text || hasExplicitContinueEvidence(text) || hasFollowupRequestAfterCompletion(text)) return false;

  const strongFarewell = /(?:^|\b)(?:adios|hasta luego|hasta pronto|me despido|que tengas buen dia|que tenga buen dia)(?:\b|$)/.test(text);
  const explicitHangup = /(?:^|\b)(?:puedes colgar|puede colgar|podemos colgar|cuelga|cuelgue)(?:\b|$)/.test(text);
  const explicitCallEnd = /(?:^|\b)(?:termina|termine|finaliza|finalice) (?:ya )?(?:la )?llamada(?:\b|$)/.test(text)
    || /(?:^|\b)quiero (?:terminar|finalizar) (?:ya )?(?:la )?llamada(?:\b|$)/.test(text);
  const explicitNoMoreNeeded = /\b(?:no necesito nada mas|no necesito mas nada|no hace falta nada mas|eso es todo|nada mas|ya hemos terminado|hemos terminado)\b/.test(text);

  return strongFarewell || explicitHangup || explicitCallEnd || explicitNoMoreNeeded;
}

/**
 * Independent controller assessment with two dimensions.
 * Courtesy is conversational context, not a close verdict. The controller may
 * therefore abstain on close intent while still recognizing courtesy.
 */
export function assessControllerCloseIntent(value: string): ControllerCloseAssessment {
  const courtesy = hasCourtesyEvidence(value);
  if (hasExplicitContinueEvidence(value)) return { courtesy, closeIntent: "CONTINUE" };
  if (hasFollowupRequestAfterCompletion(value)) return { courtesy, closeIntent: "ABSTAIN" };
  if (hasExplicitUserFarewellEvidence(value)) return { courtesy, closeIntent: "CLOSE" };
  return { courtesy, closeIntent: "ABSTAIN" };
}

/** Backward-compatible signal adapter while older callers/tests are retired. */
export type ControllerCloseSignal = "CLOSE" | "CONTINUE" | "COURTESY" | "UNRESOLVED";
export function classifyControllerCloseSignal(value: string): ControllerCloseSignal {
  const assessment = assessControllerCloseIntent(value);
  if (assessment.closeIntent === "CLOSE") return "CLOSE";
  if (assessment.closeIntent === "CONTINUE") return "CONTINUE";
  return assessment.courtesy ? "COURTESY" : "UNRESOLVED";
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
 * Consensus policy.
 * - Lucia CLOSE + controller CLOSE => strong consensus, close immediately.
 * - Courtesy + controller ABSTAIN => not an ambiguity: ask naturally whether
 *   the caller needs anything else.
 * - Lucia CLOSE + controller ABSTAIN/CONTINUE without courtesy => real
 *   disagreement/insufficient evidence, so explicitly confirm closing.
 */
export function decideCloseConsensus(
  confirmationPending: boolean,
  controller: ControllerCloseAssessment,
  luciaProposesClose: boolean,
): CloseConsensusDecision {
  if (confirmationPending) return { action: "ACK_PENDING", pending: true };
  if (!luciaProposesClose) return { action: "CONTINUE", pending: false };
  if (controller.closeIntent === "CLOSE") return { action: "CONSENSUS_CLOSE", pending: false };
  if (controller.closeIntent === "ABSTAIN" && controller.courtesy) {
    return { action: "COURTESY_FOLLOWUP", pending: false };
  }
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
    { courtesy: false, closeIntent: userClosingEvidence ? "CLOSE" : "ABSTAIN" },
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
