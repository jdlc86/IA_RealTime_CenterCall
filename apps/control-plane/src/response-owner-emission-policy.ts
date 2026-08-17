import type { ResponseOwnerEffect } from "./realtime-response-owner";

export type ResponseOwnerEmissionMode = "shadow" | "active";

export type ResponseOwnerEmissionDecision = {
  executable: ResponseOwnerEffect[];
  observedOnly: ResponseOwnerEffect[];
};

/**
 * Fail-closed boundary between the pure response owner and the Realtime socket.
 *
 * Reconciliation/diagnostic effects are never executable socket commands.
 * Runtime effects remain shadow-only until the owner is deliberately promoted
 * to active mode after synthetic coverage. This keeps activation a single,
 * auditable switch rather than scattering send() calls through lifecycle code.
 */
export function decideResponseOwnerEmission(
  effects: ResponseOwnerEffect[],
  mode: ResponseOwnerEmissionMode,
): ResponseOwnerEmissionDecision {
  const runtime = effects.filter((effect) => effect.type !== "response_ownership_conflict");
  const diagnostics = effects.filter((effect) => effect.type === "response_ownership_conflict");

  if (mode !== "active") {
    return { executable: [], observedOnly: effects };
  }

  return {
    executable: runtime,
    observedOnly: diagnostics,
  };
}
