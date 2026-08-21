import { malformedToolCorrectionRuntimeFor } from "./malformed-tool-correction-runtime.js";
import { authorizePublicRestaurantTool } from "./semantic-turn-coordinator.js";

export type PublicRestaurantToolAuthorizationRequest = Readonly<{
  name: string;
  call_id?: string;
  arguments?: string;
}>;

export type PublicRestaurantToolAuthorizationDecision = Readonly<{
  allowed: boolean;
  ignored: boolean;
  duplicateOf: string | null;
  directedIgnoreRejected: boolean;
}>;

export type PublicRestaurantToolAuthorizationPort = Readonly<{
  decide(request: PublicRestaurantToolAuthorizationRequest): PublicRestaurantToolAuthorizationDecision;
  authorize(request: PublicRestaurantToolAuthorizationRequest): boolean;
}>;

function decideAuthorization(
  session: object,
  request: PublicRestaurantToolAuthorizationRequest,
): PublicRestaurantToolAuthorizationDecision {
  const preauthorization = malformedToolCorrectionRuntimeFor(session).preauthorize(session, request);
  if (preauthorization === "ALLOW_INVALID_WITHOUT_CONSUMING") {
    return { allowed: true, ignored: false, duplicateOf: null, directedIgnoreRejected: false };
  }
  if (preauthorization === "REJECT_CROSS_TOOL_CORRECTION") {
    return { allowed: false, ignored: false, duplicateOf: null, directedIgnoreRejected: false };
  }
  return authorizePublicRestaurantTool(session, request);
}

/**
 * Version-neutral authorization boundary for public restaurant tools.
 * Malformed-tool affinity is evaluated before semantic authority so invalid JSON
 * can reach lower validation without consuming the one-tool slot. No CallSession
 * generation is allowed to intercept this boundary through historical methods.
 */
export function publicRestaurantToolAuthorizationPortFor(session: object): PublicRestaurantToolAuthorizationPort {
  return Object.freeze({
    decide(request: PublicRestaurantToolAuthorizationRequest): PublicRestaurantToolAuthorizationDecision {
      return decideAuthorization(session, request);
    },
    authorize(request: PublicRestaurantToolAuthorizationRequest): boolean {
      const decision = decideAuthorization(session, request);
      return decision.allowed && !decision.ignored && !decision.directedIgnoreRejected;
    },
  });
}
