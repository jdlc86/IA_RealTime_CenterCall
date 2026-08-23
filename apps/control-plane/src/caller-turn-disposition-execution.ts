import type { CallerTurnDispositionRequest } from "./caller-turn-disposition-port.js";
import { callerTurnDispositionPortFor } from "./caller-turn-disposition-runtime.js";

export type CallerTurnDispositionExecutor = "CAPABILITY" | "LEGACY";

/**
 * Executes an already-authorized caller-turn disposition exactly once.
 * Provider-specific effects are used only when a session-scoped capability is
 * installed; otherwise the caller supplies the validated legacy OpenAI effect.
 */
export function executeCallerTurnDisposition(
  host: object,
  request: CallerTurnDispositionRequest,
  legacyEffect: () => void,
): CallerTurnDispositionExecutor {
  if (typeof legacyEffect !== "function") throw new Error("Caller turn legacy disposition effect is required");
  const port = callerTurnDispositionPortFor(host);
  if (port) {
    port.resolve(request);
    return "CAPABILITY";
  }
  legacyEffect();
  return "LEGACY";
}
