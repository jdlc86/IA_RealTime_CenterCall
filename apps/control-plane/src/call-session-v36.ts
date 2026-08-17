import { CallSession as CallSessionV35Runtime } from "./call-session-v35-runtime";
import { restoreTurnDetectionEvent, suspendTurnDetectionEvent } from "./protected-turn-detection";
import { TurnConcurrencyLifecycle, isUsableCompletedTranscript } from "./turn-concurrency-lifecycle";
import {
  BARGE_IN_METADATA_PURPOSE,
  buildBargeInClassifierResponse,
  buildNonInterruptingListeningEvent,
  parseBargeInDecision,
} from "./barge-in-confirmation";

const BaseConstructor = CallSessionV35Runtime as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV35Runtime.prototype as any;
const TURN_LOCK_WATCHDOG_MS = 30_000;
const PROTECTED_METADATA_KEY = "protected_speech_v35";

type RealtimeEvent = {
  type?: string;
  item_id?: string;
  transcript?: unknown;
  text?: unknown;
  response_id?: string;
  response?: {
    id?: string;
    status?: string;
    metadata?: Record<string, unknown> | null;
  };
};

type PendingBargeIn = {
  itemId: string;
  transcript: string;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function parseEvent(data: unknown): RealtimeEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as RealtimeEvent; } catch { return null; }
}

function responseId(event: RealtimeEvent): string | null {
  return event.response_id ?? event.response?.id ?? null;
}

/**
 * v36 serializes usable caller turns and owns confirmed barge-in.
 *
 * During normal Lucia playback VAD stays ACTIVE, but both automatic interruption
 * and automatic response creation are disabled. A completed transcript is judged
 * by a tiny out-of-band text-only Realtime response. Only an explicit INTERRUPT
 * decision cancels Lucia and promotes that already-committed caller item into the
 * normal semantic tool pipeline. IGNORE deletes the background item and Lucia
 * continues uninterrupted.
 */
export class CallSession extends BaseConstructor {
  private turnConcurrencyV36 = new TurnConcurrencyLifecycle();
  private turnConcurrencyWatchdogV36: ReturnType<typeof setTimeout> | null = null;
  private protectedResponseIdsV36 = new Set<string>();
  private normalPlaybackActiveV36 = false;
  private normalPlaybackResponseIdV36: string | null = null;
  private pendingBargeInByItemV36 = new Map<string, PendingBargeIn>();
  private bargeInClassifierByResponseV36 = new Map<string, PendingBargeIn>();

  private acquireTurnConcurrencyV36(): void {
    if (!this.turnConcurrencyV36.acquire()) return;
    if ((this as any).state === "closing" || (this as any).hangupStarted) {
      this.turnConcurrencyV36.release();
      return;
    }

    try {
      (this as any).send?.(suspendTurnDetectionEvent());
      this.armTurnConcurrencyWatchdogV36();
      (this as any).diagnostics?.checkpoint?.("TURN_CONCURRENCY_LOCK_ACQUIRED_V36", {
        source: "completed_usable_user_transcript",
        turn_detection_suspended: true,
      });
    } catch (error) {
      this.turnConcurrencyV36.release();
      (this as any).diagnostics?.fail?.("TURN_CONCURRENCY_LOCK_FAILED_V36", "TURN_DETECTION_SUSPEND_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private releaseTurnConcurrencyV36(reason: string, restoreVad = true): void {
    if (!this.turnConcurrencyV36.release()) return;
    this.clearTurnConcurrencyWatchdogV36();

    const session = this as any;
    try {
      if (restoreVad && session.socket && session.state !== "closing" && !session.hangupStarted) {
        session.send?.({ type: "input_audio_buffer.clear" });
        session.send?.(restoreTurnDetectionEvent(session.tenantVadV35 ?? {}));
      }
    } catch (error) {
      session.diagnostics?.fail?.("TURN_CONCURRENCY_RELEASE_FAILED_V36", "TURN_DETECTION_RESTORE_FAILED", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    session.diagnostics?.checkpoint?.("TURN_CONCURRENCY_LOCK_RELEASED_V36", {
      reason,
      input_buffer_cleared: restoreVad,
      normal_barge_in_restored: restoreVad,
      vad_restore_deferred_to_playback_policy: !restoreVad,
    });
  }

  private beginConfirmedBargeInListeningV36(event: RealtimeEvent): void {
    this.releaseTurnConcurrencyV36("normal_assistant_playback_started", false);
    this.normalPlaybackActiveV36 = true;
    this.normalPlaybackResponseIdV36 = responseId(event);
    const session = this as any;
    try {
      if (session.socket && session.state !== "closing" && !session.hangupStarted) {
        session.send?.({ type: "input_audio_buffer.clear" });
        session.send?.(buildNonInterruptingListeningEvent(session.tenantVadV35 ?? {}));
      }
    } catch (error) {
      session.diagnostics?.fail?.("CONFIRMED_BARGE_IN_LISTENING_FAILED_V36", "NON_INTERRUPT_VAD_ENABLE_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    session.diagnostics?.checkpoint?.("CONFIRMED_BARGE_IN_LISTENING_V36", {
      response_id: this.normalPlaybackResponseIdV36,
      vad_active: true,
      automatic_interrupt: false,
      automatic_response: false,
    });
  }

  private finishNormalPlaybackV36(reason: string, event: RealtimeEvent): void {
    if (!this.normalPlaybackActiveV36) return;
    const id = responseId(event);
    if (this.normalPlaybackResponseIdV36 && id && id !== this.normalPlaybackResponseIdV36) return;

    this.normalPlaybackActiveV36 = false;
    this.normalPlaybackResponseIdV36 = null;
    const session = this as any;
    try {
      if (session.socket && session.state !== "closing" && !session.hangupStarted) {
        session.send?.(restoreTurnDetectionEvent(session.tenantVadV35 ?? {}));
      }
    } catch (error) {
      session.diagnostics?.fail?.("NORMAL_ASSISTANT_PLAYBACK_RELEASE_FAILED_V36", "TURN_DETECTION_RESTORE_FAILED", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    session.diagnostics?.checkpoint?.("NORMAL_ASSISTANT_PLAYBACK_RELEASED_V36", {
      reason,
      normal_barge_in_restored: true,
      pending_barge_in_classifiers: this.bargeInClassifierByResponseV36.size,
    });
  }

  private requestBargeInClassificationV36(event: RealtimeEvent, transcript: string): void {
    const itemId = typeof event.item_id === "string" && event.item_id ? event.item_id : "";
    if (!itemId) {
      (this as any).diagnostics?.fail?.("BARGE_IN_CLASSIFIER_SKIPPED_V36", "CALLER_ITEM_ID_MISSING", {});
      return;
    }
    const pending = { itemId, transcript };
    this.pendingBargeInByItemV36.set(itemId, pending);
    (this as any).send?.(buildBargeInClassifierResponse(transcript, itemId));
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_CLASSIFIER_REQUESTED_V36", {
      item_id: itemId,
      transcript_length: transcript.length,
      lucia_playback_active: this.normalPlaybackActiveV36,
    });
  }

  private ignoreBargeInCandidateV36(pending: PendingBargeIn, reason: string): void {
    this.pendingBargeInByItemV36.delete(pending.itemId);
    try {
      (this as any).send?.({ type: "conversation.item.delete", item_id: pending.itemId });
    } catch { /* best effort; semantic path remains fail-closed */ }
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_IGNORED_V36", {
      item_id: pending.itemId,
      reason,
      lucia_continues: this.normalPlaybackActiveV36,
    });
  }

  private promoteConfirmedBargeInV36(pending: PendingBargeIn): void {
    this.pendingBargeInByItemV36.delete(pending.itemId);
    const session = this as any;
    const activeResponseId = this.normalPlaybackResponseIdV36;
    this.normalPlaybackActiveV36 = false;
    this.normalPlaybackResponseIdV36 = null;

    if (activeResponseId) {
      session.send?.({ type: "response.cancel", response_id: activeResponseId });
      session.send?.({ type: "output_audio_buffer.clear" });
    }

    // The caller item already exists in the default conversation. Re-enter the
    // normal semantic pipeline deliberately; server VAD did not auto-create a response.
    this.acquireTurnConcurrencyV36();
    session.armSemanticGateV29?.(pending.transcript);
    session.confirmBargeInV40?.();
    session.send?.({ type: "response.create" });
    session.diagnostics?.checkpoint?.("BARGE_IN_CONFIRMED_V36", {
      item_id: pending.itemId,
      cancelled_response_id: activeResponseId,
      promoted_to_semantic_pipeline: true,
    });
  }

  private finalizeBargeInClassifierV36(responseIdValue: string, text: unknown): void {
    const pending = this.bargeInClassifierByResponseV36.get(responseIdValue);
    if (!pending) return;
    this.bargeInClassifierByResponseV36.delete(responseIdValue);
    const decision = parseBargeInDecision(text);
    if (decision === "INTERRUPT") this.promoteConfirmedBargeInV36(pending);
    else this.ignoreBargeInCandidateV36(pending, "classifier_ignore");
  }

  /** Higher lifecycle escape hatch for a stalled semantic turn. */
  protected releaseTurnConcurrencyForRecoveryV36(reason: string): void {
    this.releaseTurnConcurrencyV36(reason);
  }

  protected detachTurnConcurrencyForTerminalV36(reason: string): void {
    const wasActive = this.turnConcurrencyV36.release();
    this.clearTurnConcurrencyWatchdogV36();
    this.normalPlaybackActiveV36 = false;
    this.normalPlaybackResponseIdV36 = null;
    this.pendingBargeInByItemV36.clear();
    this.bargeInClassifierByResponseV36.clear();
    (this as any).diagnostics?.checkpoint?.("TURN_CONCURRENCY_DETACHED_FOR_TERMINAL_V36", {
      reason,
      was_active: wasActive,
      vad_restored: false,
    });
  }

  private discardOverlappingTurnV36(event: RealtimeEvent): void {
    const session = this as any;
    if (event.item_id && session.socket) {
      try { session.send?.({ type: "conversation.item.delete", item_id: event.item_id }); } catch { /* best effort */ }
    }
    session.diagnostics?.checkpoint?.("TURN_CONCURRENCY_OVERLAPPING_TURN_DROPPED_V36", {
      item_id: event.item_id ?? null,
      active_turn_age_ms: this.turnConcurrencyV36.ageMs(),
      semantic_processing_unchanged: true,
    });
  }

  private armTurnConcurrencyWatchdogV36(): void {
    this.clearTurnConcurrencyWatchdogV36();
    this.turnConcurrencyWatchdogV36 = setTimeout(() => {
      if (!this.turnConcurrencyV36.isActive()) return;
      (this as any).diagnostics?.fail?.("TURN_CONCURRENCY_WATCHDOG_V36", "TURN_LOCK_TERMINAL_EVENT_MISSING", {
        watchdog_ms: TURN_LOCK_WATCHDOG_MS,
        active_turn_age_ms: this.turnConcurrencyV36.ageMs(),
      });
      this.releaseTurnConcurrencyV36("watchdog");
    }, TURN_LOCK_WATCHDOG_MS);
  }

  private clearTurnConcurrencyWatchdogV36(): void {
    if (!this.turnConcurrencyWatchdogV36) return;
    clearTimeout(this.turnConcurrencyWatchdogV36);
    this.turnConcurrencyWatchdogV36 = null;
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);

    if (event?.type === "response.created") {
      const id = responseId(event);
      const metadata = event.response?.metadata ?? {};
      const protectedKind = metadata[PROTECTED_METADATA_KEY];
      if (id && (protectedKind === "GREETING" || protectedKind === "RECOVERY" || protectedKind === "TERMINAL")) {
        this.protectedResponseIdsV36.add(id);
      }
      if (id && metadata.purpose === BARGE_IN_METADATA_PURPOSE && typeof metadata.source_item_id === "string") {
        const pending = this.pendingBargeInByItemV36.get(metadata.source_item_id);
        if (pending) this.bargeInClassifierByResponseV36.set(id, pending);
      }
    }

    if (event?.type === "response.output_text.done") {
      const id = responseId(event);
      if (id && this.bargeInClassifierByResponseV36.has(id)) {
        this.finalizeBargeInClassifierV36(id, event.text);
        return;
      }
    }

    if (event?.type === "response.done") {
      const id = responseId(event);
      if (id && this.bargeInClassifierByResponseV36.has(id) && event.response?.status !== "completed") {
        const pending = this.bargeInClassifierByResponseV36.get(id)!;
        this.bargeInClassifierByResponseV36.delete(id);
        this.ignoreBargeInCandidateV36(pending, `classifier_${event.response?.status ?? "unknown"}`);
        return;
      }
    }

    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      const usable = isUsableCompletedTranscript(event.transcript);
      const transcript = usable && typeof event.transcript === "string" ? event.transcript.replace(/\s+/g, " ").trim().slice(0, 1500) : "";

      if (this.normalPlaybackActiveV36) {
        if (transcript) this.requestBargeInClassificationV36(event, transcript);
        else if (event.item_id) this.ignoreBargeInCandidateV36({ itemId: event.item_id, transcript: "" }, "empty_transcript");
        return;
      }

      if (!usable) {
        (this as any).diagnostics?.checkpoint?.("TURN_CONCURRENCY_EMPTY_TRANSCRIPT_IGNORED_V36", { lock_acquired: false });
      } else if (this.turnConcurrencyV36.isActive()) {
        this.discardOverlappingTurnV36(event);
        return;
      } else {
        this.acquireTurnConcurrencyV36();
      }
    }

    // Confirmed barge-in must be activated by every normal (non-protected)
    // Lucia playback, independently of whether a turn-concurrency lock happens
    // to be active at playback start. Tool-backed responses can legitimately
    // begin without an active lock; coupling these lifecycles made those
    // responses effectively non-interruptible.
    if (event?.type === "output_audio_buffer.started") {
      const id = responseId(event);
      const isProtected = !!(id && this.protectedResponseIdsV36.has(id));
      if (!isProtected && !this.normalPlaybackActiveV36) {
        this.beginConfirmedBargeInListeningV36(event);
      }
    }

    if (event?.type === "output_audio_buffer.stopped") {
      const id = responseId(event);
      if (id && this.protectedResponseIdsV36.has(id)) {
        this.protectedResponseIdsV36.delete(id);
        if (this.turnConcurrencyV36.isActive()) this.releaseTurnConcurrencyV36("protected_playback_completed");
      } else {
        this.finishNormalPlaybackV36("output_audio_buffer_stopped", event);
      }
    }

    if (event?.type === "output_audio_buffer.cleared") {
      const id = responseId(event);
      if (id) this.protectedResponseIdsV36.delete(id);
      this.finishNormalPlaybackV36("output_audio_buffer_cleared", event);
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
