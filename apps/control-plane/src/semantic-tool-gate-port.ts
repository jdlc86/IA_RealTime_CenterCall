import type { RealtimeProviderCommandPort } from "./realtime-provider-command-port.js";
import { requireRealtimeProviderCapabilities } from "./realtime-provider-capabilities.js";
import type { RealtimeProviderName } from "./realtime-provider-types.js";

/**
 * Neutral enforcement capability for the one-tool semantic decision gate.
 *
 * The core owns whether the gate is armed. This port owns only how the selected
 * provider enforces that requirement. OpenAI currently implements the gate via
 * its provider-specific session tool choice; Gemini must not inherit that wire
 * assumption through the generic session-policy update path.
 */
export interface SemanticToolGatePort {
  arm(): void;
  release(): void;
}

class RealtimeBackedSemanticToolGatePort implements SemanticToolGatePort {
  constructor(
    private readonly provider: RealtimeProviderName,
    private readonly realtime: RealtimeProviderCommandPort,
  ) {}

  arm(): void {
    requireRealtimeProviderCapabilities(this.provider, ["semanticToolGate"]);
    this.realtime.setSemanticToolGate(true);
  }

  release(): void {
    requireRealtimeProviderCapabilities(this.provider, ["semanticToolGate"]);
    this.realtime.setSemanticToolGate(false);
  }
}

export function createRealtimeBackedSemanticToolGatePort(
  provider: RealtimeProviderName,
  realtime: RealtimeProviderCommandPort,
): SemanticToolGatePort {
  return new RealtimeBackedSemanticToolGatePort(provider, realtime);
}
