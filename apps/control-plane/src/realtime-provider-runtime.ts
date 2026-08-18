import type {
  RealtimeInputDetectionSettings,
  RealtimeProviderCommandPort,
  RealtimeSpeechRequest,
  RealtimeTextDecisionRequest,
  RealtimeToolResultRequest,
} from "./realtime-provider-command-port.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import { realtimeCommandPortFor as openAIRealtimeCommandPortFor } from "./openai-realtime-command-adapter.js";
import { adaptOpenAIRealtimeEvent } from "./openai-realtime-event-adapter.js";

export type RealtimeProviderName = "OPENAI";
export type RealtimeToolResultPolicyDecision =
  | { action: "PASS" }
  | { action: "REPLACE_DEFAULT_RESPONSE"; speech: RealtimeSpeechRequest };
export type RealtimeToolResultPolicy = (request: RealtimeToolResultRequest) => RealtimeToolResultPolicyDecision;

export const ACTIVE_REALTIME_PROVIDER: RealtimeProviderName = "OPENAI";
export type RealtimeProviderHost = object & { send(event: Record<string, unknown>): void };

class RealtimeProviderCommandRuntime implements RealtimeProviderCommandPort {
  private toolResultPolicy: RealtimeToolResultPolicy | null = null;
  private pendingDefaultResponseReplacement: RealtimeSpeechRequest | null = null;
  constructor(private readonly delegate: RealtimeProviderCommandPort) {}
  setToolResultPolicy(policy: RealtimeToolResultPolicy): void { this.toolResultPolicy = policy; }
  speak(request: RealtimeSpeechRequest): void { this.delegate.speak(request); }
  requestTextDecision(request: RealtimeTextDecisionRequest): void { this.delegate.requestTextDecision(request); }
  submitToolResult(request: RealtimeToolResultRequest): void {
    const decision = this.toolResultPolicy?.(request) ?? { action: "PASS" as const };
    this.pendingDefaultResponseReplacement = decision.action === "REPLACE_DEFAULT_RESPONSE" ? decision.speech : null;
    this.delegate.submitToolResult(request);
  }
  updateSessionPolicy(update: { instructions?: string; toolChoice?: "AUTO" | "NONE" | "REQUIRED" }): void {
    (this.delegate as any).updateSessionPolicy(update);
  }
  createDefaultResponse(): void {
    const replacement = this.pendingDefaultResponseReplacement;
    this.pendingDefaultResponseReplacement = null;
    if (replacement) { this.delegate.speak(replacement); return; }
    this.delegate.createDefaultResponse();
  }
  cancelResponse(responseId: string): void { this.delegate.cancelResponse(responseId); }
  clearPlayback(): void { this.delegate.clearPlayback(); }
  clearInput(): void { this.delegate.clearInput(); }
  discardInputItem(itemId: string): void { this.delegate.discardInputItem(itemId); }
  suspendInputDetection(): void { this.delegate.suspendInputDetection(); }
  beginNonInterruptingListening(settings?: RealtimeInputDetectionSettings): void { this.delegate.beginNonInterruptingListening(settings); }
  restoreInputDetection(settings?: RealtimeInputDetectionSettings): void { this.delegate.restoreInputDetection(settings); }
}

const RUNTIME_BY_HOST = new WeakMap<object, RealtimeProviderCommandRuntime>();
function commandRuntimeFor(host: RealtimeProviderHost): RealtimeProviderCommandRuntime {
  let runtime = RUNTIME_BY_HOST.get(host);
  if (!runtime) {
    runtime = new RealtimeProviderCommandRuntime(openAIRealtimeCommandPortFor(host));
    RUNTIME_BY_HOST.set(host, runtime);
  }
  return runtime;
}
export function realtimeCommandPortFor(host: RealtimeProviderHost): RealtimeProviderCommandPort { return commandRuntimeFor(host); }
export function installRealtimeToolResultPolicy(host: RealtimeProviderHost, policy: RealtimeToolResultPolicy): void { commandRuntimeFor(host).setToolResultPolicy(policy); }
export function adaptRealtimeProviderEvents(data: unknown): RealtimeProviderEvent[] { return adaptOpenAIRealtimeEvent(data); }
