import type {
  RealtimeProviderCommandPort,
  RealtimeTextDecisionRequest,
} from "./realtime-provider-command-port.js";
import type { RealtimeProviderName } from "./realtime-provider-types.js";

/**
 * Provider-neutral capability for decisions that must not become conversation
 * turns. The realtime conversation provider may implement this capability, but
 * it is not required to. Providers whose isolated classifier is external to the
 * media session must install a dedicated SemanticDecisionPort instead.
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
    if (this.provider !== "OPENAI") {
      throw new Error(`Realtime-backed semantic decision is unsupported for ${this.provider}; install an external isolated decision port`);
    }
    this.realtime.requestTextDecision(request);
  }
}

/**
 * Compatibility adapter for the existing OpenAI isolated-response mechanism.
 * Product-level isolatedTextDecision capability does not imply that a provider's
 * live conversational command port owns that mechanism. Gemini, for example,
 * satisfies the capability through an external one-shot classifier and must never
 * fall through to Gemini Live requestTextDecision.
 */
export function createRealtimeBackedSemanticDecisionPort(
  provider: RealtimeProviderName,
  realtime: RealtimeProviderCommandPort,
): SemanticDecisionPort {
  return new RealtimeBackedSemanticDecisionPort(provider, realtime);
}
