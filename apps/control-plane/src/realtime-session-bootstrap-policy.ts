import type { RealtimeSessionPolicyUpdate } from "./realtime-provider-command-port.js";
import {
  realtimeCapabilitiesFor,
  realtimeCommandPortFor,
  realtimeProviderFor,
  type RealtimeProviderHost,
} from "./realtime-provider-runtime.js";

export type RealtimeSessionBootstrapPolicyResult = Readonly<{
  provider: ReturnType<typeof realtimeProviderFor>;
  mode: "RUNTIME_UPDATE" | "IMMUTABLE_BOOTSTRAP";
}>;

/**
 * Applies startup policy only when the immutable provider contract requires a
 * runtime update. Gemini's admitted media-edge bootstrap already owns the one
 * Live setup message, so replaying the same policy through the live command port
 * would be an invalid dynamic mutation.
 */
export function applyRealtimeSessionBootstrapPolicy(
  host: RealtimeProviderHost,
  update: RealtimeSessionPolicyUpdate,
): RealtimeSessionBootstrapPolicyResult {
  const provider = realtimeProviderFor(host);
  const capabilities = realtimeCapabilitiesFor(host);

  if (capabilities.runtimeInstructionPolicyUpdate) {
    realtimeCommandPortFor(host).updateSessionPolicy(update);
    return Object.freeze({ provider, mode: "RUNTIME_UPDATE" as const });
  }

  if (typeof update.instructions !== "string" || !update.instructions.trim()) {
    throw new Error(`Realtime provider ${provider} cannot absorb a non-instruction startup policy`);
  }
  if (!capabilities.initialInstructionBootstrap) {
    throw new Error(`Realtime provider ${provider} lacks immutable instruction bootstrap`);
  }
  if (update.tools !== undefined && !capabilities.toolCatalogBootstrap) {
    throw new Error(`Realtime provider ${provider} lacks immutable tool-catalog bootstrap`);
  }

  return Object.freeze({ provider, mode: "IMMUTABLE_BOOTSTRAP" as const });
}
