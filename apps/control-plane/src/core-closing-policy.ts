import type { CoreIntent, CoreWorkflow } from "./core-intent-machine.js";

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

export type ContextualCloseResolution = "CLOSE" | "CONTINUE" | "UNRESOLVED";

function normalizeClosingText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
}

function hasExplicitContinueEvidence(value: string): boolean {
  const text = normalizeClosingText(value);
  return /\b(?:no|todavia no|aun no) (?:quiero )?(?:terminar|finalizar|colgar|que cuelgues|que cuelgue)\b/.test(text)
    || /\b(?:no cuelgues|no cuelgue|sigue|continua|continuemos)\b/.test(text);
}

function hasFollowupRequest(value: string): boolean {
  const text = normalizeClosingText(value);
  return /\b(?:pero|aunque|ahora|ademas|tambien|espera|un momento)\b.*\b(?:dime|cuentame|quiero|necesito|puedes|podrias|quisiera|preguntar|saber|consultar|una cosa|otra cosa)\b/.test(text)
    || /\b(?:pero|ahora|ademas|tambien|espera)\b.*\b(?:menu|horario|reserva|reservas|direccion|precio|precios|telefono)\b/.test(text);
}

function hasCompletionLanguage(value: string): boolean {
  const text = normalizeClosingText(value);
  return /\b(?:no necesito nada mas|no necesito mas nada|no hace falta nada mas|eso es todo|nada mas|ya esta|hemos terminado|ya hemos terminado)\b/.test(text);
}

function hasFollowupRequestAfterCompletion(value: string): boolean {
  return hasCompletionLanguage(value) && hasFollowupRequest(value);
}

function hasCourtesyEvidence(value: string): boolean {
  const text = normalizeClosingText(value);
  if (!text) return false;
  return /\b(?:gracias|muchas gracias|te lo agradezco|se lo agradezco|muy amable)\b/.test(text);
}

function hasContextualNewRequestEvidence(value: string): boolean {
  const text = normalizeClosingText(value);
  if (!text) return false;
  if (hasExplicitContinueEvidence(value) || hasFollowupRequest(value)) return true;

  // The caller may answer the more-help question with courtesy and a direct
  // request but without a connector such as "pero": "gracias, dime el horario".
  // Treat that substantive request as authoritative over the courtesy.
  return /\b(?:dime|cuentame|explicame|quiero saber|quisiera saber|necesito saber|puedes decirme|podrias decirme|me puedes decir|me podrias decir|tengo (?:otra|una) (?:pregunta|consulta)|una cosa mas|otra cosa)\b/.test(text)
    || /\b(?:a que hora|donde|cuando|cuanto|cuantos|cual|cuales|como puedo|que (?:horario|menu|direccion|precio|telefono))\b/.test(text);
}

function hasContextualPositiveEvidence(value: string): boolean {
  const text = normalizeClosingText(value);
  if (!text) return false;
  if (/^(?:si|si claro|claro|vale|de acuerdo)(?:\b|$)/.test(text)) return true;
  return /^(?:gracias|muchas gracias|muy amable|perfecto gracias)\s+(?:si|claro)(?:\b|$)/.test(text);
}

export function isAssistantMoreHelpQuestion(value: string): boolean {
  const text = normalizeClosingText(value);
  if (!text) return false;
  const asksForMore = /\b(?:algo mas|alguna cosa mas|alguna otra cosa|en algo mas)\b/.test(text);
  const offersHelp = /\b(?:puedo ayudarte|pueda ayudarte|te puedo ayudar|te pueda ayudar|puedo ayudar|pueda ayudar|necesitas|necesita|quieres|quiere)\b/.test(text);
  return asksForMore && offersHelp;
}

export function resolveReplyToMoreHelpQuestion(value: string): ContextualCloseResolution {
  const text = normalizeClosingText(value);
  if (!text) return "UNRESOLVED";

  // While an explicit more-help question is pending, resolve the caller's
  // contextual meaning before generic courtesy/closing arbitration. A new
  // request always wins, including terse forms such as "gracias, dime el horario".
  if (hasContextualNewRequestEvidence(value) || hasContextualPositiveEvidence(value)) return "CONTINUE";

  // A direct farewell while answering an explicit more-help question is already
  // a complete contextual close signal. Reuse the same deterministic evidence
  // used by spontaneous closing instead of forcing a second model-dependent path.
  if (hasExplicitUserFarewellEvidence(value)) return "CLOSE";

  // In this context, clear completion language and direct negative answers
  // resolve NO_MORE_HELP without asking an additional closing question.
  if (hasCompletionLanguage(value)) return "CLOSE";
  if (/^(?:no)(?: no)*(?: gracias)?$/.test(text)) return "CLOSE";

  // Courtesy alone is not global close evidence, but as the direct answer to
  // "¿Necesitas algo más...?" it naturally means no more help is requested.
  // assessControllerCloseIntent intentionally continues to ABSTAIN on these
  // same phrases outside the explicit more-help context.
  if (hasCourtesyEvidence(value)) return "CLOSE";
  return "UNRESOLVED";
}

export function hasExplicitUserFarewellEvidence(value: string): boolean {
  const text = normalizeClosingText(value);
  if (!text || hasExplicitContinueEvidence(text) || hasFollowupRequest(text)) return false;
  const strongFarewell = /(?:^|\b)(?:adios|hasta luego|hasta pronto|hasta otra|nos vemos|me despido|chao|chau|que tengas buen dia|que tenga buen dia|que vaya bien)(?:\b|$)/.test(text);
  const explicitHangup = /(?:^|\b)(?:puedes colgar|puede colgar|podemos colgar|cuelga|cuelgue)(?:\b|$)/.test(text);
  const explicitCallEnd = /(?:^|\b)(?:termina|termine|finaliza|finalice) (?:ya )?(?:la )?llamada(?:\b|$)/.test(text)
    || /(?:^|\b)quiero (?:terminar|finalizar) (?:ya )?(?:la )?llamada(?:\b|$)/.test(text);
  return strongFarewell || explicitHangup || explicitCallEnd || hasCompletionLanguage(text);
}

export function assessControllerCloseIntent(value: string): ControllerCloseAssessment {
  const courtesy = hasCourtesyEvidence(value);
  if (hasExplicitContinueEvidence(value)) return { courtesy, closeIntent: "CONTINUE" };
  if (hasFollowupRequestAfterCompletion(value)) return { courtesy, closeIntent: "ABSTAIN" };
  if (hasExplicitUserFarewellEvidence(value)) return { courtesy, closeIntent: "CLOSE" };
  return { courtesy, closeIntent: "ABSTAIN" };
}

export type ContextualMoreHelpSemanticDecision = "CLOSE" | "CONTINUE";

/**
 * Dedicated semantic recovery is allowed to close only on an exact positive
 * CLOSE decision. Malformed, missing or ambiguous model output fails safe to
 * CONTINUE so this auxiliary classifier can never create a false hangup.
 */
export function parseContextualMoreHelpSemanticDecision(value: unknown): ContextualMoreHelpSemanticDecision {
  if (typeof value !== "string") return "CONTINUE";
  const normalized = value.trim().toUpperCase().replace(/[^A-Z]/g, "");
  return normalized === "CLOSE" ? "CLOSE" : "CONTINUE";
}

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

export function shouldCommitPendingClose(closingConfirmationPending: boolean, transcript: string): boolean {
  return closingConfirmationPending && isExplicitClosingConfirmation(transcript);
}

export function decideCloseConsensus(
  confirmationPending: boolean,
  controller: ControllerCloseAssessment,
  luciaProposesClose: boolean,
): CloseConsensusDecision {
  if (confirmationPending) return { action: "ACK_PENDING", pending: true };
  if (!luciaProposesClose) return { action: "CONTINUE", pending: false };
  if (controller.closeIntent === "CLOSE") return { action: "CONSENSUS_CLOSE", pending: false };
  if (controller.closeIntent === "ABSTAIN" && controller.courtesy) return { action: "COURTESY_FOLLOWUP", pending: false };
  return { action: "AMBIGUOUS_CONFIRM", pending: true };
}

export function decideEndCallProposal(
  closingConfirmationPending: boolean,
  userClosingEvidence: boolean,
  modelConfirmed: boolean,
): EndCallProposalDecision {
  const decision = decideCloseConsensus(closingConfirmationPending, { courtesy: false, closeIntent: userClosingEvidence ? "CLOSE" : "ABSTAIN" }, modelConfirmed);
  if (decision.action === "CONSENSUS_CLOSE") return { action: "ALLOW_CLOSE" };
  if (decision.action === "ACK_PENDING") return { action: "ACK_PENDING" };
  return { action: "ASK_CONFIRMATION" };
}

export function decideClosingTransition(
  _currentWorkflow: CoreWorkflow,
  requestedWorkflow: CoreIntent,
  closingPending: boolean,
  explicitClosingConfirmed = false,
): ClosingDecision {
  if (requestedWorkflow !== "CLOSING") return { action: "CONTINUE", pending: false };
  if (explicitClosingConfirmed || closingPending) return { action: "ALLOW_CLOSE", pending: false };
  return { action: "ASK_CONFIRMATION", pending: true };
}
