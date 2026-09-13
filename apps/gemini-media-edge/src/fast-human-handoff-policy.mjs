const AUTHORIZATION_SOURCES = new Set(["EXPLICIT_REQUEST", "CONFIRMED_OFFER"]);

export function initialFastHandoffAuthorizationState() {
  return Object.freeze({ version: 1 });
}

/**
 * Human-handoff authority is semantic and belongs to Gemini. The kernel does
 * not maintain a vocabulary of accepted phrases. The generic tool kernel has
 * already required and consumed an opaque runtime caller-turn receipt before
 * this transfer-specific policy validates the supported semantic source.
 */
export function authorizeFastHumanHandoff(state, input = {}) {
  const current = state && typeof state === "object" ? state : initialFastHandoffAuthorizationState();
  const authorization = typeof input.authorization === "string" ? input.authorization.trim() : "";
  if (!AUTHORIZATION_SOURCES.has(authorization)) {
    return Object.freeze({ allowed: false, source: "CALLER_AUTHORITY_REQUIRED", state: current });
  }

  return Object.freeze({ allowed: true, source: authorization, state: current });
}
