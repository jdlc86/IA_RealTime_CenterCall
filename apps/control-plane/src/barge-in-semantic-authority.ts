import type { ResponseOwnerState } from "./realtime-response-owner";

export type BargeInPublicToolRoute = "DEFER_TO_CLASSIFIER" | "ALLOW_SEMANTIC_PIPELINE";

/**
 * v40 is the single semantic authority while a normal-playback interruption is
 * still being classified. Lower layers must not acquire a public-tool decision
 * until that classification has resolved.
 */
export function decideBargeInPublicToolRoute(ownerState: ResponseOwnerState | null | undefined): BargeInPublicToolRoute {
  return ownerState === "BARGE_IN_CLASSIFYING"
    ? "DEFER_TO_CLASSIFIER"
    : "ALLOW_SEMANTIC_PIPELINE";
}
