import type { RealtimeProviderCommandPort } from "./realtime-provider-command-port.js";
import { requireRealtimeProviderCapabilities } from "./realtime-provider-capabilities.js";
import type { RealtimeProviderName } from "./realtime-provider-types.js";

/**
 * Neutral enforcement capability for the one-tool semantic decision gate.
 *
 * The core owns whether the gate is armed. This port owns only how the selected
 * provider enforces that requirement. OpenAI currently implements the gate via
 * response/session tool choice; Gemini must not inherit that wire assumption.
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
    this.realtime.updateSessionPolicy({ toolChoice: "REQUIRED" });
  }

  release(): void {
    requireRealtimeProviderCapabilities(this.provider, ["semanticToolGate"]);
    this.realtime.updateSessionPolicy({ toolChoice: "AUTO" });
  }
}

export function createRealtimeBackedSemanticToolGatePort(
  provider: RealtimeProviderName,
  realtime: RealtimeProviderCommandPort,
): SemanticToolGatePort {
  return new RealtimeBackedSemanticToolGatePort(provider, realtime);
}
