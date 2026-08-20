import type {
  RealtimeInputDetectionSettings,
  RealtimeProviderCommandPort,
  RealtimeSemanticResponseRequest,
  RealtimeSessionPolicyUpdate,
  RealtimeSpeechRequest,
  RealtimeTextDecisionRequest,
  RealtimeToolResultRequest,
} from "./realtime-provider-command-port.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import { realtimeCommandPortFor as openAIRealtimeCommandPortFor } from "./openai-realtime-command-adapter.js";
import { adaptOpenAIRealtimeEvent } from "./openai-realtime-event-adapter.js";
import {
  realtimeProviderCapabilities,
  type ProviderCapabilities,
} from "./realtime-provider-capabilities.js";
import {
  DEFAULT_REALTIME_PROVIDER,
  isRegisteredRealtimeProvider,
  type RealtimeProviderName,
} from "./realtime-provider-selector.js";

export type RealtimeToolResultPolicyDecision =
  | { action: "PASS" }
  | { action: "REPLACE_DEFAULT_RESPONSE"; speech: RealtimeSpeechRequest };
export type RealtimeToolResultPolicy = (request: RealtimeToolResultRequest) => RealtimeToolResultPolicyDecision;
export type RealtimeSessionPolicyTransform = (update: RealtimeSessionPolicyUpdate) => RealtimeSessionPolicyUpdate;

export const ACTIVE_REALTIME_PROVIDER: RealtimeProviderName = DEFAULT_REALTIME_PROVIDER;
export type RealtimeProviderHost = object & { send(event: Record<string, unknown>): void };

class RealtimeProviderCommandRuntime implements RealtimeProviderCommandPort {
  private toolResultPolicy: RealtimeToolResultPolicy | null = null;
  private sessionPolicyTransforms: RealtimeSessionPolicyTransform[] = [];
  private pendingDefaultResponseReplacement: RealtimeSpeechRequest | null = null;
  private deferredDefaultResponseReplacement: RealtimeSpeechRequest | null = null;
  private stagedCallerTurnText: string | null = null;
  private activeAssistantResponseId: string | null | undefined = undefined;
  readonly capabilities: ProviderCapabilities;

  constructor(
    readonly provider: RealtimeProviderName,
    private readonly delegate: RealtimeProviderCommandPort,
  ) {
    this.capabilities = realtimeProviderCapabilities(provider);
  }

  setToolResultPolicy(policy: RealtimeToolResultPolicy): void { this.toolResultPolicy = policy; }
  addSessionPolicyTransform(transform: RealtimeSessionPolicyTransform): void { this.sessionPolicyTransforms.push(transform); }
  stageCallerTurn(text: string | null): void { this.stagedCallerTurnText = text?.trim() || null; }
  clearStagedCallerTurn(): void { this.stagedCallerTurnText = null; }
  speak(request: RealtimeSpeechRequest): void { this.delegate.speak(request); }
  requestTextDecision(request: RealtimeTextDecisionRequest): void { this.delegate.requestTextDecision(request); }
  createSemanticResponse(request: RealtimeSemanticResponseRequest): void { this.delegate.createSemanticResponse(request); }
  hasActiveAssistantResponse(): boolean { return this.activeAssistantResponseId !== undefined; }

  submitToolResult(request: RealtimeToolResultRequest): void {
    const decision = this.toolResultPolicy?.(request) ?? { action: "PASS" as const };
    this.pendingDefaultResponseReplacement = decision.action === "REPLACE_DEFAULT_RESPONSE" ? decision.speech : null;
    this.delegate.submitToolResult(request);
  }

  updateSessionPolicy(update: RealtimeSessionPolicyUpdate): void {
    const governed = this.sessionPolicyTransforms.reduce((current, transform) => transform(current), update);
    this.delegate.updateSessionPolicy(governed);
  }

  createDefaultResponse(): void {
    const replacement = this.pendingDefaultResponseReplacement;
    this.pendingDefaultResponseReplacement = null;
    if (replacement) {
      if (this.activeAssistantResponseId !== undefined) {
        this.deferredDefaultResponseReplacement = replacement;
        return;
      }
      this.delegate.speak(replacement);
      return;
    }

    const callerTurnText = this.stagedCallerTurnText;
    this.stagedCallerTurnText = null;
    if (callerTurnText) {
      this.delegate.createSemanticResponse({
        callerTurnText,
        purpose: "consolidated_caller_turn",
        metadata: { consolidated_caller_turn: true },
      });
      return;
    }

    this.delegate.createDefaultResponse();
  }

  observeAssistantResponseStarted(responseId?: string): void {
    this.activeAssistantResponseId = responseId ?? null;
  }

  observeAssistantResponseCompleted(responseId?: string): void {
    const activeResponseId = this.activeAssistantResponseId;
    if (activeResponseId === undefined) return;
    if (activeResponseId !== null) {
      if (!responseId || responseId !== activeResponseId) return;
    } else if (responseId) {
      return;
    }
    this.activeAssistantResponseId = undefined;
    const deferred = this.deferredDefaultResponseReplacement;
    this.deferredDefaultResponseReplacement = null;
    if (deferred) this.delegate.speak(deferred);
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
const PROVIDER_BY_HOST = new WeakMap<object, RealtimeProviderName>();

function createProviderCommandPort(provider: RealtimeProviderName, host: RealtimeProviderHost): RealtimeProviderCommandPort {
  switch (provider) {
    case "OPENAI": return openAIRealtimeCommandPortFor(host);
  }
}

export function bindRealtimeProvider(host: RealtimeProviderHost, provider: RealtimeProviderName): void {
  if (!isRegisteredRealtimeProvider(provider)) throw new Error(`Realtime provider is not registered: ${String(provider)}`);
  realtimeProviderCapabilities(provider);
  const runtime = RUNTIME_BY_HOST.get(host);
  if (runtime && runtime.provider !== provider) throw new Error(`Realtime provider already initialized as ${runtime.provider}`);
  PROVIDER_BY_HOST.set(host, provider);
}

export function realtimeProviderFor(host: RealtimeProviderHost): RealtimeProviderName {
  return PROVIDER_BY_HOST.get(host) ?? DEFAULT_REALTIME_PROVIDER;
}

export function realtimeCapabilitiesFor(host: RealtimeProviderHost): ProviderCapabilities {
  return realtimeProviderCapabilities(realtimeProviderFor(host));
}

function commandRuntimeFor(host: RealtimeProviderHost): RealtimeProviderCommandRuntime {
  let runtime = RUNTIME_BY_HOST.get(host);
  if (!runtime) {
    const provider = realtimeProviderFor(host);
    runtime = new RealtimeProviderCommandRuntime(provider, createProviderCommandPort(provider, host));
    RUNTIME_BY_HOST.set(host, runtime);
  }
  return runtime;
}

export function realtimeCommandPortFor(host: RealtimeProviderHost): RealtimeProviderCommandPort { return commandRuntimeFor(host); }
export function realtimeAssistantResponseActiveFor(host: RealtimeProviderHost): boolean { return commandRuntimeFor(host).hasActiveAssistantResponse(); }
export function stageConsolidatedCallerTurnForNextResponse(host: RealtimeProviderHost, text: string): void { commandRuntimeFor(host).stageCallerTurn(text); }
export function clearConsolidatedCallerTurnForNextResponse(host: RealtimeProviderHost): void { commandRuntimeFor(host).clearStagedCallerTurn(); }
export function installRealtimeToolResultPolicy(host: RealtimeProviderHost, policy: RealtimeToolResultPolicy): void { commandRuntimeFor(host).setToolResultPolicy(policy); }
export function installRealtimeSessionPolicyTransform(host: RealtimeProviderHost, transform: RealtimeSessionPolicyTransform): void { commandRuntimeFor(host).addSessionPolicyTransform(transform); }
export function observeRealtimeAssistantResponseStarted(host: RealtimeProviderHost, responseId?: string): void { commandRuntimeFor(host).observeAssistantResponseStarted(responseId); }
export function observeRealtimeAssistantResponseCompleted(host: RealtimeProviderHost, responseId?: string): void { commandRuntimeFor(host).observeAssistantResponseCompleted(responseId); }

export function adaptRealtimeProviderEvents(data: unknown): RealtimeProviderEvent[] { return adaptOpenAIRealtimeEvent(data); }
