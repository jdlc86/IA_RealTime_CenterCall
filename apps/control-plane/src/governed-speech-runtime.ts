import type {
  RealtimeProviderCommandPort,
  RealtimeSpeechRequest,
} from "./realtime-provider-command-port.js";
import type { RealtimeProviderName } from "./realtime-provider-selector.js";
import {
  deterministicToolContinuationPort,
  type RealtimeDeterministicToolContinuationPort,
} from "./realtime-deterministic-tool-continuation.js";

export interface GovernedSpeechPort {
  speak(request: RealtimeSpeechRequest): void;
}

type InstalledGovernedSpeechPort = Readonly<{
  provider: RealtimeProviderName;
  port: GovernedSpeechPort;
}>;

const EXTERNAL_GOVERNED_SPEECH_BY_HOST = new WeakMap<object, InstalledGovernedSpeechPort>();

function requireHost(host: object): object {
  if (!host || typeof host !== "object") throw new Error("Governed speech host is required");
  return host;
}

function requirePort(port: GovernedSpeechPort): GovernedSpeechPort {
  if (!port || typeof port.speak !== "function") throw new Error("Governed speech port is required");
  return port;
}

export function installGovernedSpeechPort(
  host: object,
  provider: RealtimeProviderName,
  port: GovernedSpeechPort,
): void {
  const key = requireHost(host);
  const capability = requirePort(port);
  const existing = EXTERNAL_GOVERNED_SPEECH_BY_HOST.get(key);
  if (existing && (existing.provider !== provider || existing.port !== capability)) {
    throw new Error(`Governed speech port is already installed for ${existing.provider}`);
  }
  EXTERNAL_GOVERNED_SPEECH_BY_HOST.set(key, Object.freeze({ provider, port: capability }));
}

export function removeGovernedSpeechPort(
  host: object,
  provider: RealtimeProviderName,
  port?: GovernedSpeechPort,
): void {
  const key = requireHost(host);
  const existing = EXTERNAL_GOVERNED_SPEECH_BY_HOST.get(key);
  if (!existing) return;
  if (existing.provider !== provider) {
    throw new Error(`Governed speech port ownership mismatch: ${existing.provider}/${provider}`);
  }
  if (port && existing.port !== port) throw new Error("Governed speech port ownership mismatch");
  EXTERNAL_GOVERNED_SPEECH_BY_HOST.delete(key);
}

function governedSpeechPortFor(
  host: object,
  provider: RealtimeProviderName,
): GovernedSpeechPort | null {
  const key = requireHost(host);
  const installed = EXTERNAL_GOVERNED_SPEECH_BY_HOST.get(key);
  if (!installed) return null;
  if (installed.provider !== provider) {
    throw new Error(`Governed speech port affinity mismatch: ${installed.provider}/${provider}`);
  }
  return installed.port;
}

/**
 * Decorates a provider command port so every governed speech emission traverses
 * the session-scoped speech capability. All non-speech commands retain their
 * provider implementation unchanged. Looking up the capability at call time is
 * intentional: the sideband may install/remove it during its exact lifecycle.
 */
export function withGovernedSpeechPort(
  host: object,
  provider: RealtimeProviderName,
  delegate: RealtimeProviderCommandPort,
): RealtimeProviderCommandPort {
  requireHost(host);
  if (!delegate || typeof delegate.speak !== "function") throw new Error("Realtime provider command port is required");

  const decorated: RealtimeProviderCommandPort & Partial<RealtimeDeterministicToolContinuationPort> = {
    speak(request) {
      const external = governedSpeechPortFor(host, provider);
      if (external) external.speak(request);
      else delegate.speak(request);
    },
    requestTextDecision(request) { delegate.requestTextDecision(request); },
    createSemanticResponse(request) { delegate.createSemanticResponse(request); },
    submitToolResult(request) { delegate.submitToolResult(request); },
    updateSessionPolicy(update) { delegate.updateSessionPolicy(update); },
    setSemanticToolGate(armed) { delegate.setSemanticToolGate(armed); },
    createDefaultResponse() { delegate.createDefaultResponse(); },
    cancelResponse(responseId) { delegate.cancelResponse(responseId); },
    clearPlayback() { delegate.clearPlayback(); },
    clearInput() { delegate.clearInput(); },
    discardInputItem(itemId) { delegate.discardInputItem(itemId); },
    suspendInputDetection() { delegate.suspendInputDetection(); },
    beginNonInterruptingListening(settings) { delegate.beginNonInterruptingListening(settings); },
    restoreInputDetection(settings) { delegate.restoreInputDetection(settings); },
  };
  const deterministic = deterministicToolContinuationPort(delegate);
  if (deterministic) {
    decorated.bypassDeterministicToolContinuation = (request, context) => {
      deterministic.bypassDeterministicToolContinuation(request, context);
    };
  }
  return decorated;
}
