import { malformedToolCorrectionRuntimeFor } from "./malformed-tool-correction-runtime.js";
import { authorizePublicRestaurantTool } from "./semantic-turn-coordinator.js";

export type PublicRestaurantToolAuthorizationRequest = Readonly<{
  name: string;
  call_id?: string;
  arguments?: string;
}>;

export type PublicRestaurantToolAuthorizationPort = Readonly<{
  authorize(request: PublicRestaurantToolAuthorizationRequest): boolean;
}>;

/**
 * Version-neutral authorization boundary for public restaurant tools.
 * Malformed-tool affinity is evaluated before semantic authority so invalid JSON
 * can reach lower validation without consuming the one-tool slot. No CallSession
 * generation is allowed to intercept this boundary through historical methods.
 */
export function publicRestaurantToolAuthorizationPortFor(session: object): PublicRestaurantToolAuthorizationPort {
  return Object.freeze({
    authorize(request: PublicRestaurantToolAuthorizationRequest): boolean {
      const preauthorization = malformedToolCorrectionRuntimeFor(session).preauthorize(session, request);
      if (preauthorization === "ALLOW_INVALID_WITHOUT_CONSUMING") return true;
      if (preauthorization === "REJECT_CROSS_TOOL_CORRECTION") return false;

      const semantic = authorizePublicRestaurantTool(session, request);
      return semantic.allowed && !semantic.ignored && !semantic.directedIgnoreRejected;
    },
  });
}
