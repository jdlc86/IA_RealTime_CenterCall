import type { GovernedSpeechPort } from "./governed-speech-runtime.js";
import type { RealtimeProviderCommandPort, RealtimeSpeechRequest } from "./realtime-provider-command-port.js";
import type { AssistantSpeechKind, RealtimeProviderEvent } from "./realtime-provider-event.js";
import type { SemanticToolGatePort } from "./semantic-tool-gate-port.js";
import { geminiGovernedSpeechDescriptor } from "./gemini-governed-speech-descriptor.js";
import {
  GeminiLiveSessionRuntime,
  type GeminiLiveSessionRuntimeObservation,
} from "./gemini-live-session-runtime.js";

export type GeminiMediaEdgeCallerDecision = "NORMAL" | "INTERRUPT" | "IGNORE";
export type GeminiMediaEdgeSidebandOutbound =
  | Readonly<{ type: "TOOL_RESULT"; callId: string; toolName: string; output: unknown }>
  | Readonly<{ type: "PLAYBACK_BINDING"; responseId: string; kind: "NORMAL" }>
  | Readonly<{ type: "PLAYBACK_DRAIN"; responseId: string }>
  | Readonly<{ type: "PLAYBACK_CLEAR"; responseId: string }>
  | Readonly<{
      type: "GOVERNED_SPEECH";
      responseId: string;
      text: string;
      kind?: Exclude<AssistantSpeechKind, "NORMAL">;
      purpose?: string;
    }>
  | Readonly<{ type: "CALLER_TURN_DECISION"; itemId: string; decision: GeminiMediaEdgeCallerDecision; responseId: string | null }>
  | Readonly<{ type: "SEMANTIC_GATE_ARM" }>
  | Readonly<{ type: "SEMANTIC_GATE_RELEASE" }>
  | Readonly<{ type: "CALLER_INPUT_CLEAR" }>
  | Readonly<{ type: "INPUT_DETECTION_SUSPEND" }>
  | Readonly<{ type: "INPUT_DETECTION_RESTORE" }>;
export type GeminiMediaEdgeSidebandSend = (message: GeminiMediaEdgeSidebandOutbound) => void;
export type GeminiMediaEdgeCallerContext = Readonly<{ itemId: string; playbackResponseIdAtStart: string | null }>;

function object(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is invalid`); return value as Record<string, unknown>; }
function required(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`); return value.trim(); }
function optionalId(value: unknown, field: string): string | null { if (value == null) return null; return required(value, field); }
function governedEventKind(value: unknown): AssistantSpeechKind {
  if (value === "NORMAL" || value === "GREETING" || value === "RECOVERY" || value === "TERMINAL" || value === "PRESENCE" || value === "HANDOFF") return value;
  throw new Error("Gemini governed event kind is unsupported");
}
function outboundToolResult(message: Record<string, unknown>): GeminiMediaEdgeSidebandOutbound {
  const toolResponse = object(message.toolResponse, "Gemini sideband toolResponse");
  const responses = toolResponse.functionResponses;
  if (!Array.isArray(responses) || responses.length !== 1) throw new Error("Gemini sideband requires exactly one FunctionResponse");
  const response = object(responses[0], "Gemini sideband FunctionResponse");
  const body = object(response.response, "Gemini sideband FunctionResponse response");
  if (!("result" in body)) throw new Error("Gemini sideband FunctionResponse result is required");
  return Object.freeze({ type: "TOOL_RESULT", callId: required(response.id, "Gemini sideband FunctionResponse id"), toolName: required(response.name, "Gemini sideband FunctionResponse name"), output: structuredClone(body.result) });
}
function mediaEdgeCommandPort(
  delegate: RealtimeProviderCommandPort,
  send: GeminiMediaEdgeSidebandSend,
  activePlaybackResponseId: () => string | null,
): RealtimeProviderCommandPort {
  const port: RealtimeProviderCommandPort = {
    speak(request) { delegate.speak(request); },
    requestTextDecision(request) { delegate.requestTextDecision(request); },
    createSemanticResponse(request) { delegate.createSemanticResponse(request); },
    submitToolResult(request) { delegate.submitToolResult(request); },
    updateSessionPolicy(update) { delegate.updateSessionPolicy(update); },
    setSemanticToolGate(armed) { delegate.setSemanticToolGate(armed); },
    createDefaultResponse() { delegate.createDefaultResponse(); },
    cancelResponse(responseId) { delegate.cancelResponse(responseId); },
    clearPlayback() {
      const responseId = activePlaybackResponseId();
      if (!responseId) throw new Error("Gemini playback clear requires active correlated playback");
      send(Object.freeze({ type: "PLAYBACK_CLEAR", responseId }));
    },
    clearInput() { send(Object.freeze({ type: "CALLER_INPUT_CLEAR" })); },
    discardInputItem(itemId) { delegate.discardInputItem(itemId); },
    suspendInputDetection() { send(Object.freeze({ type: "INPUT_DETECTION_SUSPEND" })); },
    beginNonInterruptingListening() { send(Object.freeze({ type: "INPUT_DETECTION_RESTORE" })); },
    restoreInputDetection() { send(Object.freeze({ type: "INPUT_DETECTION_RESTORE" })); },
  };
  return Object.freeze(port);
}
function playbackBinding(events: readonly RealtimeProviderEvent[]): GeminiMediaEdgeSidebandOutbound | null {
  const started = events.filter((event): event is Extract<RealtimeProviderEvent, { type: "ASSISTANT_RESPONSE_STARTED" }> => event.type === "ASSISTANT_RESPONSE_STARTED");
  if (!started.length) return null;
  if (started.length !== 1) throw new Error("Gemini sideband observation produced multiple response starts");
  return Object.freeze({ type: "PLAYBACK_BINDING", responseId: required(started[0].responseId, "Gemini sideband playback response id"), kind: "NORMAL" });
}
function playbackDrain(events: readonly RealtimeProviderEvent[]): GeminiMediaEdgeSidebandOutbound | null {
  const completed = events.filter((event): event is Extract<RealtimeProviderEvent, { type: "ASSISTANT_RESPONSE_COMPLETED" }> => event.type === "ASSISTANT_RESPONSE_COMPLETED" && event.status === "completed");
  if (!completed.length) return null;
  if (completed.length !== 1) throw new Error("Gemini sideband observation produced multiple completed responses");
  return Object.freeze({ type: "PLAYBACK_DRAIN", responseId: required(completed[0].responseId, "Gemini sideband completed response id") });
}

export class GeminiMediaEdgeSidebandRuntime {
  private readonly runtime: GeminiLiveSessionRuntime;
  private readonly send: GeminiMediaEdgeSidebandSend;
  private readonly callerContexts = new Map<string, GeminiMediaEdgeCallerContext>();
  private activePlaybackResponseId: string | null = null;
  private activePlaybackKind: AssistantSpeechKind | null = null;
  readonly commandPort: RealtimeProviderCommandPort;
  readonly semanticToolGatePort: SemanticToolGatePort;
  readonly governedSpeechPort: GovernedSpeechPort;

  constructor(send: GeminiMediaEdgeSidebandSend) {
    if (typeof send !== "function") throw new Error("Gemini media edge sideband sender is required");
    this.send = send;
    this.runtime = new GeminiLiveSessionRuntime({ send: (message) => send(outboundToolResult(message)) }, { model: "external-media-edge" });
    this.runtime.adoptExternalSetupSent();
    this.commandPort = mediaEdgeCommandPort(this.runtime.commandPort, this.send, () => this.activePlaybackResponseId);
    this.semanticToolGatePort = Object.freeze({
      arm: () => this.send(Object.freeze({ type: "SEMANTIC_GATE_ARM" })),
      release: () => this.send(Object.freeze({ type: "SEMANTIC_GATE_RELEASE" })),
    });
    this.governedSpeechPort = Object.freeze({
      speak: (request: RealtimeSpeechRequest) => {
        const descriptor = geminiGovernedSpeechDescriptor(request);
        this.send(Object.freeze({
          type: "GOVERNED_SPEECH",
          responseId: descriptor.responseId,
          text: descriptor.text,
          ...(descriptor.kind === "NORMAL" ? {} : { kind: descriptor.kind }),
          ...(descriptor.purpose ? { purpose: descriptor.purpose } : {}),
        }));
      },
    });
  }

  observe(frameValue: unknown): GeminiLiveSessionRuntimeObservation {
    const frame = object(frameValue, "Gemini media edge sideband frame");
    if (frame.type === "GEMINI_EVENT") {
      const observation = this.runtime.observe(JSON.stringify(structuredClone(frame.message)));
      const binding = playbackBinding(observation.events); if (binding) this.send(binding);
      const drain = playbackDrain(observation.events); if (drain) this.send(drain);
      return observation;
    }
    if (frame.type === "CALLER_EVENT") return this.observeCallerEvent(frame.event);
    if (frame.type === "PLAYBACK_EVENT") return this.observePlaybackEvent(frame.event);
    if (frame.type === "GOVERNED_EVENT") return this.observeGovernedEvent(frame.event);
    if (frame.type === "INPUT_DETECTION_EVENT") return this.observeInputDetectionEvent(frame.event);
    throw new Error("Gemini media edge sideband frame type is unsupported");
  }

  callerContext(itemId: string): GeminiMediaEdgeCallerContext | null { return this.callerContexts.get(required(itemId, "Gemini sideband caller item id")) ?? null; }

  /** Provider-effect boundary. Semantic authority must decide before calling this. */
  resolveCallerTurn(itemId: string, decision: GeminiMediaEdgeCallerDecision): GeminiMediaEdgeCallerContext {
    const id = required(itemId, "Gemini sideband caller item id");
    const context = this.callerContexts.get(id);
    if (!context) throw new Error(`Gemini sideband caller context is not active: ${id}`);
    if (!["NORMAL", "INTERRUPT", "IGNORE"].includes(decision)) throw new Error("Gemini sideband caller decision is invalid");

    let wireDecision: GeminiMediaEdgeCallerDecision = decision;
    let responseId: string | null = null;
    const target = context.playbackResponseIdAtStart;
    const activeResponseId = this.runtime.snapshot().activeResponseId;
    const activePlaybackResponseId = this.activePlaybackResponseId;

    if (decision === "NORMAL") {
      if (activeResponseId || activePlaybackResponseId) throw new Error("Gemini normal caller turn requires idle response and playback");
    } else if (decision === "INTERRUPT") {
      if (!target) throw new Error("Gemini interruption requires caller playback identity");
      if (activeResponseId && activeResponseId !== target) throw new Error(`Gemini interruption target superseded by active response ${activeResponseId}`);
      if (activePlaybackResponseId && activePlaybackResponseId !== target) throw new Error(`Gemini interruption playback identity mismatch: expected ${activePlaybackResponseId}`);
      if (!activeResponseId && !activePlaybackResponseId) {
        wireDecision = "NORMAL";
      } else {
        responseId = target;
      }
    }

    this.send(Object.freeze({ type: "CALLER_TURN_DECISION", itemId: id, decision: wireDecision, responseId }));
    if (wireDecision !== "IGNORE") this.runtime.noteCallerTurnCommitted();
    this.callerContexts.delete(id);
    return context;
  }

  consumeCallerContext(itemId: string): GeminiMediaEdgeCallerContext {
    const id = required(itemId, "Gemini sideband caller item id");
    const context = this.callerContexts.get(id);
    if (!context) throw new Error(`Gemini sideband caller context is not active: ${id}`);
    this.callerContexts.delete(id);
    return context;
  }
  snapshot() { return this.runtime.snapshot(); }
  close() {
    this.callerContexts.clear();
    this.activePlaybackResponseId = null;
    this.activePlaybackKind = null;
    return this.runtime.close();
  }

  private observeCallerEvent(value: unknown): GeminiLiveSessionRuntimeObservation {
    const edge = object(value, "Gemini media edge caller event");
    const type = required(edge.type, "Gemini media edge caller event type");
    if (type === "CALLER_SPEECH_STARTED") {
      const itemId = required(edge.itemId, "Gemini media edge caller item id");
      if (this.callerContexts.has(itemId)) throw new Error(`Gemini sideband caller item already active: ${itemId}`);
      const playbackResponseIdAtStart = optionalId(edge.playbackResponseIdAtStart, "Gemini media edge caller playback response id");
      if (playbackResponseIdAtStart && playbackResponseIdAtStart !== this.activePlaybackResponseId) throw new Error(`Gemini sideband caller playback identity mismatch: expected ${this.activePlaybackResponseId ?? "<none>"}`);
      this.callerContexts.set(itemId, Object.freeze({ itemId, playbackResponseIdAtStart }));
      return this.edgeObservation({ type: "CALLER_SPEECH_STARTED", itemId });
    }
    if (type === "CALLER_SPEECH_STOPPED") {
      const itemId = required(edge.itemId, "Gemini media edge caller item id");
      if (!this.callerContexts.has(itemId)) throw new Error(`Gemini sideband caller speech stop has no active item: ${itemId}`);
      return this.edgeObservation({ type: "CALLER_SPEECH_STOPPED" });
    }
    if (type === "CALLER_TRANSCRIPT_COMPLETED") {
      const itemId = required(edge.itemId, "Gemini media edge caller item id");
      if (!this.callerContexts.has(itemId)) throw new Error(`Gemini sideband caller transcript has no active item: ${itemId}`);
      return this.edgeObservation({ type: "CALLER_TRANSCRIPT_COMPLETED", itemId, transcript: required(edge.transcript, "Gemini media edge caller transcript") });
    }
    throw new Error("Gemini media edge caller event type is unsupported");
  }

  private observeGovernedEvent(value: unknown): GeminiLiveSessionRuntimeObservation {
    const edge = object(value, "Gemini governed lifecycle event");
    const type = required(edge.type, "Gemini governed lifecycle event type");
    const responseId = required(edge.responseId, "Gemini governed lifecycle response id");
    const kind = governedEventKind(edge.kind);
    if (type === "ASSISTANT_RESPONSE_STARTED") {
      const purpose = edge.purpose == null ? undefined : required(edge.purpose, "Gemini governed lifecycle purpose");
      return this.edgeObservation({ type, kind, responseId, ...(purpose ? { purpose } : {}) });
    }
    if (type === "ASSISTANT_RESPONSE_COMPLETED") {
      const status = edge.status == null ? undefined : required(edge.status, "Gemini governed lifecycle status");
      return this.edgeObservation({ type, kind, responseId, ...(status ? { status } : {}) });
    }
    throw new Error("Gemini governed lifecycle event type is unsupported");
  }

  private observePlaybackEvent(value: unknown): GeminiLiveSessionRuntimeObservation {
    const edge = object(value, "Gemini media edge playback event");
    const type = required(edge.type, "Gemini media edge playback event type");
    const responseId = required(edge.responseId, "Gemini media edge playback response id");
    const kind = governedEventKind(edge.kind);
    if (type === "ASSISTANT_AUDIO_STARTED") {
      if (this.activePlaybackResponseId && this.activePlaybackResponseId !== responseId) throw new Error(`Gemini sideband playback already owned by ${this.activePlaybackResponseId}`);
      if (this.activePlaybackKind && this.activePlaybackKind !== kind) throw new Error(`Gemini sideband playback kind mismatch: expected ${this.activePlaybackKind}`);
      this.activePlaybackResponseId = responseId;
      this.activePlaybackKind = kind;
      return this.edgeObservation({ type: "ASSISTANT_AUDIO_STARTED", kind, responseId });
    }
    if (type === "ASSISTANT_AUDIO_STOPPED" || type === "ASSISTANT_AUDIO_CLEARED") {
      if (this.activePlaybackResponseId !== responseId) throw new Error(`Gemini sideband playback completion identity mismatch: expected ${this.activePlaybackResponseId ?? "<none>"}`);
      if (this.activePlaybackKind !== kind) throw new Error(`Gemini sideband playback completion kind mismatch: expected ${this.activePlaybackKind ?? "<none>"}`);
      this.activePlaybackResponseId = null;
      this.activePlaybackKind = null;
      return this.edgeObservation({ type, kind, responseId } as RealtimeProviderEvent);
    }
    throw new Error("Gemini media edge playback event type is unsupported");
  }

  private observeInputDetectionEvent(value: unknown): GeminiLiveSessionRuntimeObservation {
    const edge = object(value, "Gemini media edge input detection event");
    if (edge.type !== "INPUT_DETECTION_UPDATED" || edge.present !== true) {
      throw new Error("Gemini media edge input detection event is unsupported");
    }
    if (edge.settings === null) {
      return this.edgeObservation({ type: "INPUT_DETECTION_UPDATED", present: true, settings: null });
    }
    const settings = object(edge.settings, "Gemini media edge input detection settings");
    if (settings.createResponse !== false || settings.interruptResponse !== false) {
      throw new Error("Gemini media edge input detection settings are unsupported");
    }
    return this.edgeObservation({
      type: "INPUT_DETECTION_UPDATED",
      present: true,
      settings: { createResponse: false, interruptResponse: false },
    });
  }

  private edgeObservation(event: RealtimeProviderEvent): GeminiLiveSessionRuntimeObservation {
    return Object.freeze({ events: Object.freeze([event]), transcriptionChunks: Object.freeze([]), cancelledToolCallIds: Object.freeze([]), snapshot: this.runtime.snapshot() });
  }
}
