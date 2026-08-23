import type {
  RealtimeProviderCommandPort,
  RealtimeTextDecisionRequest,
} from "./realtime-provider-command-port.js";
import {
  requireRealtimeProviderCapabilities,
} from "./realtime-provider-capabilities.js";
import type { RealtimeProviderName } from "./realtime-provider-types.js";

/**
 * Provider-neutral capability for decisions that must not become conversation
 * turns. The realtime conversation provider may implement this capability, but
 * it is not required to. A future Gemini bundle can therefore compose a
 * dedicated decision adapter without injecting controller authority into Live
 * caller input.
 */
export interface SemanticDecisionPort {
  request(request: RealtimeTextDecisionRequest): void;
}

class RealtimeBackedSemanticDecisionPort implements SemanticDecisionPort {
  constructor(
    private readonly provider: RealtimeProviderName,
    private readonly realtime: RealtimeProviderCommandPort,
  ) {}

  request(request: RealtimeTextDecisionRequest): void {
    requireRealtimeProviderCapabilities(this.provider, ["isolatedTextDecision"]);
    this.realtime.requestTextDecision(request);
  }
}

export function createRealtimeBackedSemanticDecisionPort(
  provider: RealtimeProviderName,
  realtime: RealtimeProviderCommandPort,
): SemanticDecisionPort {
  return new RealtimeBackedSemanticDecisionPort(provider, realtime);
}
