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
import {
  buildGeminiLiveInitialSetup,
  GeminiLiveCommandAdapter,
  type GeminiLiveCommandHost,
  type GeminiLiveInitialSetup,
} from "./gemini-live-command-adapter.js";
import { adaptGeminiLiveEvent } from "./gemini-live-event-adapter.js";
import {
  GeminiLiveSessionOwner,
  type GeminiLiveOwnerObservation,
  type GeminiLiveSessionSnapshot,
} from "./gemini-live-session-owner.js";

export type GeminiLiveSessionRuntimeObservation = Readonly<{
  events: readonly RealtimeProviderEvent[];
  transcriptionChunks: GeminiLiveOwnerObservation["transcriptionChunks"];
  cancelledToolCallIds: readonly string[];
  snapshot: GeminiLiveSessionSnapshot;
}>;

class OwnedGeminiCommandPort implements RealtimeProviderCommandPort {
  constructor(
    private readonly delegate: GeminiLiveCommandAdapter,
    private readonly owner: GeminiLiveSessionOwner,
  ) {}

  speak(request: RealtimeSpeechRequest): void { this.delegate.speak(request); }
  requestTextDecision(request: RealtimeTextDecisionRequest): void { this.delegate.requestTextDecision(request); }
  createSemanticResponse(request: RealtimeSemanticResponseRequest): void { this.delegate.createSemanticResponse(request); }

  submitToolResult(request: RealtimeToolResultRequest): void {
    if (!request.callId) throw new Error("Gemini Live owned tool response requires callId");
    this.owner.assertPendingToolCall(request.callId);
    this.delegate.submitToolResult(request);
    this.owner.noteToolResponseSubmitted(request.callId);
  }

  updateSessionPolicy(update: RealtimeSessionPolicyUpdate): void { this.delegate.updateSessionPolicy(update); }
  createDefaultResponse(): void { this.delegate.createDefaultResponse(); }
  cancelResponse(_responseId: string): void { this.delegate.cancelResponse(); }
  clearPlayback(): void { this.delegate.clearPlayback(); }
  clearInput(): void { this.delegate.clearInput(); }
  discardInputItem(_itemId: string): void { this.delegate.discardInputItem(); }
  suspendInputDetection(): void { this.delegate.suspendInputDetection(); }
  beginNonInterruptingListening(_settings?: RealtimeInputDetectionSettings): void {
    this.delegate.beginNonInterruptingListening();
  }
  restoreInputDetection(_settings?: RealtimeInputDetectionSettings): void {
    this.delegate.restoreInputDetection();
  }
}

/**
 * Single Gemini Live edge composition authority for G2.
 *
 * It owns immutable setup, stateful lifecycle correlation and the command port.
 * Gemini remains traffic-disabled; this runtime is a conformance boundary only
 * until media and voice gates are proven.
 */
export class GeminiLiveSessionRuntime {
  private readonly owner = new GeminiLiveSessionOwner();
  private readonly adapter: GeminiLiveCommandAdapter;
  readonly commandPort: RealtimeProviderCommandPort;

  constructor(
    private readonly host: GeminiLiveCommandHost,
    private readonly initialSetup: GeminiLiveInitialSetup,
  ) {
    this.adapter = new GeminiLiveCommandAdapter(host);
    this.commandPort = new OwnedGeminiCommandPort(this.adapter, this.owner);
  }

  start(): GeminiLiveSessionSnapshot {
    const snapshot = this.owner.markSetupSent();
    try {
      this.host.send(buildGeminiLiveInitialSetup(this.initialSetup));
      return snapshot;
    } catch (error) {
      this.owner.close();
      throw error;
    }
  }

  observe(data: unknown): GeminiLiveSessionRuntimeObservation {
    const owned = this.owner.observe(data);
    const stateless = adaptGeminiLiveEvent(data);
    return Object.freeze({
      events: Object.freeze([...owned.events, ...stateless]),
      transcriptionChunks: owned.transcriptionChunks,
      cancelledToolCallIds: owned.cancelledToolCallIds,
      snapshot: owned.snapshot,
    });
  }

  snapshot(): GeminiLiveSessionSnapshot { return this.owner.snapshot(); }
  close(): GeminiLiveSessionSnapshot { return this.owner.close(); }
}
