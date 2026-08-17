import type { CoreWorkflow } from "./core-intent-machine.js";

export type ClosingDecision =
  | { action: "ALLOW_CLOSE"; pending: false }
  | { action: "ASK_CONFIRMATION"; pending: true }
  | { action: "CONTINUE"; pending: false };

function normalizeClosingText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasExplicitUserFarewellEvidence(value: string): boolean {
  const text = normalizeClosingText(value);
  if (!text) return false;
  return /^(?:vale |ok |perfecto )?(?:adios|hasta luego|hasta pronto|me despido|puedes colgar|puede colgar|cuelga|termina la llamada|terminar la llamada|finaliza la llamada|finalizar la llamada|quiero terminar la llamada|quiero finalizar la llamada|eso es todo|nada mas|no necesito nada mas)(?:\b|$)/.test(text)
    || /^(?:gracias )+(?:adios|hasta luego|hasta pronto)(?:\b|$)/.test(text);
}

export function isExplicitClosingConfirmation(value: string): boolean {
  const text = normalizeClosingText(value);
  return /^(?:si|si claro|claro|de acuerdo|vale|ok|correcto|confirmo)(?:\b|$)/.test(text);
}

/**
 * A semantic CLOSING decision is model-derived and the transition is irreversible.
 * Therefore an unconfirmed closing request still requires one explicit confirmation.
 *
 * The structured conversation contract may mark a turn as explicitly confirmed
 * only when the user directly answers a prior continuation/closing question with
 * an unequivocal end-of-call response. That pair (CLOSING + explicit confirmation)
 * is enough to close without asking a redundant second question.
 */
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
