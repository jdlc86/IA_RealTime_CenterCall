import type { RealtimeProviderCommandPort } from "./realtime-provider-command-port.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import type { SemanticToolGatePort } from "./semantic-tool-gate-port.js";
import {
  GeminiLiveSessionRuntime,
  type GeminiLiveSessionRuntimeObservation,
} from "./gemini-live-session-runtime.js";

export type GeminiMediaEdgeCallerDecision = "NORMAL" | "INTERRUPT" | "IGNORE";
export type GeminiMediaEdgeSidebandOutbound =
  | Readonly<{ type: "TOOL_RESULT"; callId: string; toolName: string; output: unknown }>
  | Readonly<{ type: "PLAYBACK_BINDING"; responseId: string; kind: "NORMAL" }>
  | Readonly<{ type: "PLAYBACK_DRAIN"; responseId: string }>
  | Readonly<{ type: "CALLER_TURN_DECISION"; itemId: string; decision: GeminiMediaEdgeCallerDecision; responseId: string | null }>
  | Readonly<{ type: "SEMANTIC_GATE_ARM" }>
  | Readonly<{ type: "SEMANTIC_GATE_RELEASE" }>;
export type GeminiMediaEdgeSidebandSend = (message: GeminiMediaEdgeSidebandOutbound) => void;
export type GeminiMediaEdgeCallerContext = Readonly<{ itemId: string; playbackResponseIdAtStart: string | null }>;

function object(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is invalid`); return value as Record<string, unknown>; }
function required(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`); return value.trim(); }
function optionalId(value: unknown, field: string): string | null { if (value == null) return null; return required(value, field); }
function outboundToolResult(message: Record<string, unknown>): GeminiMediaEdgeSidebandOutbound {
  const toolResponse = object(message.toolResponse, "Gemini sideband toolResponse");
  const responses = toolResponse.functionResponses;
  if (!Array.isArray(responses) || responses.length !== 1) throw new Error("Gemini sideband requires exactly one FunctionResponse");
  const response = object(responses[0], "Gemini sideband FunctionResponse");
  const body = object(response.response, "Gemini sideband FunctionResponse response");
  if (!("result" in body)) throw new Error("Gemini sideband FunctionResponse result is required");
  return Object.freeze({ type: "TOOL_RESULT", callId: required(response.id, "Gemini sideband FunctionResponse id"), toolName: required(response.name, "Gemini sideband FunctionResponse name"), output: structuredClone(body.result) });
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
  readonly commandPort: RealtimeProviderCommandPort;
  readonly semanticToolGatePort: SemanticToolGatePort;

  constructor(send: GeminiMediaEdgeSidebandSend) {
    if (typeof send !== "function") throw new Error("Gemini media edge sideband sender is required");
    this.send = send;
    this.runtime = new GeminiLiveSessionRuntime({ send: (message) => send(outboundToolResult(message)) }, { model: "external-media-edge" });
    this.runtime.adoptExternalSetupSent();
    this.commandPort = this.runtime.commandPort;
    this.semanticToolGatePort = Object.freeze({
      arm: () => this.send(Object.freeze({ type: "SEMANTIC_GATE_ARM" })),
      release: () => this.send(Object.freeze({ type: "SEMANTIC_GATE_RELEASE" })),
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
        // Match the validated deferred-input coordinator: once the captured target
        // fully drains and nothing supersedes it, preserve speech as a normal turn.
        wireDecision = "NORMAL";
      } else {
        responseId = target;
      }
    }

    this.send(Object.freeze({ type: "CALLER_TURN_DECISION", itemId: id, decision: wireDecision, responseId }));
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
  close() { this.callerContexts.clear(); this.activePlaybackResponseId = null; return this.runtime.close(); }

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

  private observePlaybackEvent(value: unknown): GeminiLiveSessionRuntimeObservation {
    const edge = object(value, "Gemini media edge playback event");
    const type = required(edge.type, "Gemini media edge playback event type");
    const responseId = required(edge.responseId, "Gemini media edge playback response id");
    if (edge.kind !== "NORMAL") throw new Error("Gemini media edge playback kind is unsupported");
    if (type === "ASSISTANT_AUDIO_STARTED") {
      if (this.activePlaybackResponseId && this.activePlaybackResponseId !== responseId) throw new Error(`Gemini sideband playback already owned by ${this.activePlaybackResponseId}`);
      this.activePlaybackResponseId = responseId;
      return this.edgeObservation({ type: "ASSISTANT_AUDIO_STARTED", kind: "NORMAL", responseId });
    }
    if (type === "ASSISTANT_AUDIO_STOPPED" || type === "ASSISTANT_AUDIO_CLEARED") {
      if (this.activePlaybackResponseId !== responseId) throw new Error(`Gemini sideband playback completion identity mismatch: expected ${this.activePlaybackResponseId ?? "<none>"}`);
      this.activePlaybackResponseId = null;
      return this.edgeObservation({ type, kind: "NORMAL", responseId } as RealtimeProviderEvent);
    }
    throw new Error("Gemini media edge playback event type is unsupported");
  }

  private edgeObservation(event: RealtimeProviderEvent): GeminiLiveSessionRuntimeObservation {
    return Object.freeze({ events: Object.freeze([event]), transcriptionChunks: Object.freeze([]), cancelledToolCallIds: Object.freeze([]), snapshot: this.runtime.snapshot() });
  }
}
