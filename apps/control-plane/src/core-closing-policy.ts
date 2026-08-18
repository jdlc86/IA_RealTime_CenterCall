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
  if (hasFollowupRequest(value)) return "CONTINUE";
  if (/^(?:no)(?: no)*(?: gracias)?$/.test(text)) return "CLOSE";
  if (/^(?:nada mas|no necesito nada mas|no necesito mas nada|eso es todo|ya esta)(?: gracias)?$/.test(text)) return "CLOSE";
  if (/^(?:si|si claro|claro|vale|de acuerdo)(?:\b|$)/.test(text)) return "CONTINUE";
  return "UNRESOLVED";
}

export function hasExplicitUserFarewellEvidence(value: string): boolean {
  const text = normalizeClosingText(value);
  if (!text || hasExplicitContinueEvidence(text) || hasFollowupRequest(text)) return false;
  const strongFarewell = /(?:^|\b)(?:adios|hasta luego|hasta pronto|me despido|que tengas buen dia|que tenga buen dia)(?:\b|$)/.test(text);
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
  requestedWorkflow: CoreWorkflow,
  closingPending: boolean,
  explicitClosingConfirmed = false,
): ClosingDecision {
  if (requestedWorkflow !== "CLOSING") return { action: "CONTINUE", pending: false };
  if (explicitClosingConfirmed || closingPending) return { action: "ALLOW_CLOSE", pending: false };
  return { action: "ASK_CONFIRMATION", pending: true };
}
