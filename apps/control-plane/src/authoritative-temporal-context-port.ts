import type { RealtimeProviderCommandPort } from "./realtime-provider-command-port.js";
import { requireRealtimeProviderCapabilities } from "./realtime-provider-capabilities.js";
import type { RealtimeProviderName } from "./realtime-provider-types.js";
import { withAuthoritativeNowContext } from "./temporal-grounding.js";

export type AuthoritativeTemporalContextRefresh = Readonly<{
  baseInstructions: string;
  now?: Date;
}>;

/**
 * Provider-neutral capability for keeping the model grounded in backend-owned time.
 *
 * Callers request the semantic effect only. They do not know whether a provider
 * achieves it with a session mutation, a dedicated context primitive, a tool, or
 * another edge-specific mechanism.
 */
export interface AuthoritativeTemporalContextPort {
  refresh(request: AuthoritativeTemporalContextRefresh): void;
}

class RealtimeBackedAuthoritativeTemporalContextPort implements AuthoritativeTemporalContextPort {
  constructor(
    private readonly provider: RealtimeProviderName,
    private readonly realtime: RealtimeProviderCommandPort,
  ) {}

  refresh(request: AuthoritativeTemporalContextRefresh): void {
    requireRealtimeProviderCapabilities(this.provider, ["authoritativeTemporalContext"]);
    this.realtime.updateSessionPolicy({
      instructions: withAuthoritativeNowContext(request.baseInstructions, request.now ?? new Date()),
    });
  }
}

export function createRealtimeBackedAuthoritativeTemporalContextPort(
  provider: RealtimeProviderName,
  realtime: RealtimeProviderCommandPort,
): AuthoritativeTemporalContextPort {
  return new RealtimeBackedAuthoritativeTemporalContextPort(provider, realtime);
}
