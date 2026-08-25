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
import { GeminiLiveCallerActivityOwner } from "./gemini-live-caller-activity-owner.js";
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

export type GeminiLiveCallerActivityBoundary = Readonly<{
  event: RealtimeProviderEvent;
  itemId: string;
}>;

class OwnedGeminiCommandPort implements RealtimeProviderCommandPort {
  private readonly providerOwnedContinuationReasons = new Set<"CALLER_TURN" | "TOOL_RESULT">();
  private expectedToolContinuationResponseId: string | null = null;

  constructor(
    private readonly delegate: GeminiLiveCommandAdapter,
    private readonly owner: GeminiLiveSessionOwner,
  ) {}

  speak(request: RealtimeSpeechRequest): void { this.delegate.speak(request); }
  requestTextDecision(request: RealtimeTextDecisionRequest): void { this.delegate.requestTextDecision(request); }
  createSemanticResponse(request: RealtimeSemanticResponseRequest): void { this.delegate.createSemanticResponse(request); }

  noteCallerTurnCommitted(): void {
    if (this.providerOwnedContinuationReasons.has("CALLER_TURN")) {
      throw new Error("Gemini Live caller turn continuation is already pending");
    }
    this.providerOwnedContinuationReasons.add("CALLER_TURN");
  }

  submitToolResult(request: RealtimeToolResultRequest): void {
    if (!request.callId) throw new Error("Gemini Live owned tool response requires callId");
    this.owner.assertPendingToolCall(request.callId);
    const before = this.owner.snapshot();
    if (!before.activeResponseId) {
      throw new Error("Gemini Live owned tool response requires an active provider response");
    }
    this.delegate.submitToolResult(request);
    const after = this.owner.noteToolResponseSubmitted(request.callId);
    this.providerOwnedContinuationReasons.add("TOOL_RESULT");
    if (after.pendingToolCallIds.length === 0) {
      this.expectedToolContinuationResponseId = before.activeResponseId;
    }
  }

  noteProviderResponseCompleted(responseId: string | undefined, status: string | undefined): void {
    if (status !== "completed" || !responseId || responseId !== this.expectedToolContinuationResponseId) return;
    const snapshot = this.owner.snapshot();
    if (snapshot.state !== "READY" || snapshot.activeResponseId !== null || snapshot.pendingToolCallIds.length > 0) {
      throw new Error(`Gemini Live tool continuation completion is inconsistent with session state ${snapshot.state}`);
    }
    this.providerOwnedContinuationReasons.delete("TOOL_RESULT");
    this.expectedToolContinuationResponseId = null;
  }

  updateSessionPolicy(update: RealtimeSessionPolicyUpdate): void { this.delegate.updateSessionPolicy(update); }
  setSemanticToolGate(armed: boolean): void { this.delegate.setSemanticToolGate(armed); }

  createDefaultResponse(): void {
    if (this.providerOwnedContinuationReasons.size > 0) {
      const snapshot = this.owner.snapshot();
      if (this.providerOwnedContinuationReasons.has("TOOL_RESULT")) {
        if (snapshot.state !== "TOOL_WAIT" && snapshot.state !== "GENERATING") {
          throw new Error(`Gemini Live tool continuation is invalid while session state is ${snapshot.state}`);
        }
        if (snapshot.pendingToolCallIds.length > 0) return;
        this.expectedToolContinuationResponseId = null;
      }
      this.providerOwnedContinuationReasons.clear();
      return;
    }
    this.delegate.createDefaultResponse();
  }

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
 * Single Gemini Live edge composition authority for G2/G3 conformance.
 *
 * It owns immutable setup, stateful response lifecycle, caller activity identity
 * and the command port. Provider identity is selected outside this runtime once
 * per call and never changes during the session.
 */
export class GeminiLiveSessionRuntime {
  private readonly owner = new GeminiLiveSessionOwner();
  private readonly callerActivity = new GeminiLiveCallerActivityOwner();
  private readonly adapter: GeminiLiveCommandAdapter;
  private readonly ownedCommandPort: OwnedGeminiCommandPort;
  readonly commandPort: RealtimeProviderCommandPort;

  constructor(
    private readonly host: GeminiLiveCommandHost,
    private readonly initialSetup: GeminiLiveInitialSetup,
  ) {
    this.adapter = new GeminiLiveCommandAdapter(host);
    this.ownedCommandPort = new OwnedGeminiCommandPort(this.adapter, this.owner);
    this.commandPort = this.ownedCommandPort;
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

  /**
   * Adopt a session whose immutable setup was emitted by the external media edge.
   * No provider wire message is sent here. This preserves GeminiLiveSessionOwner
   * as the single lifecycle authority while keeping setup ownership at the edge.
   */
  adoptExternalSetupSent(): GeminiLiveSessionSnapshot {
    return this.owner.markSetupSent();
  }

  beginCallerActivity(): GeminiLiveCallerActivityBoundary {
    if (!this.initialSetup.manualActivityDetection) {
      throw new Error("Gemini Live caller activity boundaries require manualActivityDetection setup");
    }
    if (this.callerActivity.active()) {
      throw new Error(`Gemini caller activity already active: ${this.callerActivity.active()}`);
    }
    this.host.send({ realtimeInput: { activityStart: {} } });
    const started = this.callerActivity.begin();
    const itemId = "itemId" in started.event && typeof started.event.itemId === "string"
      ? started.event.itemId
      : "";
    if (!itemId) throw new Error("Gemini caller activity owner failed to create item identity");
    return Object.freeze({ event: started.event, itemId });
  }

  endCallerActivity(): GeminiLiveCallerActivityBoundary {
    if (!this.initialSetup.manualActivityDetection) {
      throw new Error("Gemini Live caller activity boundaries require manualActivityDetection setup");
    }
    const itemId = this.callerActivity.active();
    if (!itemId) throw new Error("Gemini caller activity cannot end without an active item");
    this.host.send({ realtimeInput: { activityEnd: {} } });
    const stopped = this.callerActivity.end();
    return Object.freeze({ event: stopped.event, itemId: stopped.itemId });
  }

  /** Records that authenticated caller audio was committed and will make Live continue automatically. */
  noteCallerTurnCommitted(): void {
    this.ownedCommandPort.noteCallerTurnCommitted();
  }

  observe(data: unknown): GeminiLiveSessionRuntimeObservation {
    const owned = this.owner.observe(data);
    for (const event of owned.events) {
      if (event.type === "ASSISTANT_RESPONSE_COMPLETED") {
        this.ownedCommandPort.noteProviderResponseCompleted(event.responseId, event.status);
      }
    }
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
