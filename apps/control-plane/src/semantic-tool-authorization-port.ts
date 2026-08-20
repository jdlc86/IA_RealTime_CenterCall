import { authorizePublicRestaurantTool } from "./semantic-turn-coordinator.js";

export type PublicRestaurantToolAuthorizationRequest = Readonly<{
  name: string;
  call_id?: string;
  arguments?: string;
}>;

export type PublicRestaurantToolAuthorizationPort = Readonly<{
  authorize(request: PublicRestaurantToolAuthorizationRequest): boolean;
}>;

type LegacySemanticAuthoritySession = {
  authorizePublicRestaurantToolV29?: (request: PublicRestaurantToolAuthorizationRequest) => boolean;
};

/**
 * Version-neutral compatibility port for public restaurant-tool authority.
 *
 * The active CallSession chain still exposes one historical interception hook so
 * the malformed-tool correction layer can participate before semantic authority
 * is consumed. Consolidation layers depend only on this port; the legacy method
 * adaptation is isolated here and can disappear when correction ownership is
 * fully composed into a neutral runtime.
 */
export function publicRestaurantToolAuthorizationPortFor(session: object): PublicRestaurantToolAuthorizationPort {
  return Object.freeze({
    authorize(request: PublicRestaurantToolAuthorizationRequest): boolean {
      const legacy = session as LegacySemanticAuthoritySession;
      if (typeof legacy.authorizePublicRestaurantToolV29 === "function") {
        return legacy.authorizePublicRestaurantToolV29(request);
      }
      const semantic = authorizePublicRestaurantTool(session, request);
      return semantic.allowed && !semantic.ignored && !semantic.directedIgnoreRejected;
    },
  });
}
