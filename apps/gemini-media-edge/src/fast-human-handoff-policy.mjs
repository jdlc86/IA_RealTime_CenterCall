const AUTHORIZATION_SOURCES = new Set(["EXPLICIT_REQUEST", "CONFIRMED_OFFER"]);

function canonicalEvidence(value) {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

export function initialFastHandoffAuthorizationState() {
  return Object.freeze({ version: 1 });
}

/**
 * Human-handoff authority is semantic and belongs to Gemini. The kernel does
 * not maintain a vocabulary of accepted phrases. It only verifies that Gemini
 * declared a supported authority state and grounded that decision in words
 * that are actually present in the caller transcript captured for this tool.
 */
export function authorizeFastHumanHandoff(state, input = {}) {
  const current = state && typeof state === "object" ? state : initialFastHandoffAuthorizationState();
  const authorization = typeof input.authorization === "string" ? input.authorization.trim() : "";
  if (!AUTHORIZATION_SOURCES.has(authorization)) {
    return Object.freeze({ allowed: false, source: "CALLER_AUTHORITY_REQUIRED", state: current });
  }

  const callerTranscript = canonicalEvidence(input.callerTranscript);
  const callerAuthorityEvidence = canonicalEvidence(input.callerAuthorityEvidence);
  if (!callerAuthorityEvidence || !callerTranscript || !callerTranscript.includes(callerAuthorityEvidence)) {
    return Object.freeze({ allowed: false, source: "CALLER_AUTHORITY_EVIDENCE_MISMATCH", state: current });
  }

  return Object.freeze({ allowed: true, source: authorization, state: current });
}
