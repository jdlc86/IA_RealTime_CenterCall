import { CallSession as CallSessionV35Runtime } from "./call-session-v35-runtime";
import { restoreTurnDetectionEvent, suspendTurnDetectionEvent } from "./protected-turn-detection";
import { TurnConcurrencyLifecycle } from "./turn-concurrency-lifecycle";

const BaseConstructor = CallSessionV35Runtime as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV35Runtime.prototype as any;
const TURN_LOCK_WATCHDOG_MS = 30_000;
const PROTECTED_METADATA_KEY = "protected_speech_v35";

type RealtimeEvent = {
  type?: string;
  item_id?: string;
  response_id?: string;
  response?: {
    id?: string;
    metadata?: Record<string, unknown> | null;
  };
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
 * v36 serializes ordinary caller turns while Lucia is processing one semantic turn.
 *
 * Higher layers may explicitly take ownership of a completed transcript by overriding
 * shouldBypassTurnConcurrencyV36(). This prevents two independent lifecycle owners
 * from locking/dropping the same already-classified barge-in turn.
 */
export class CallSession extends BaseConstructor {
  private turnConcurrencyV36 = new TurnConcurrencyLifecycle();
  private turnConcurrencyWatchdogV36: ReturnType<typeof setTimeout> | null = null;
  private protectedResponseIdsV36 = new Set<string>();

  protected shouldBypassTurnConcurrencyV36(_event: RealtimeEvent): boolean {
    return false;
  }

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
        source: "completed_user_transcript",
        turn_detection_suspended: true,
      });
    } catch (error) {
      this.turnConcurrencyV36.release();
      (this as any).diagnostics?.fail?.("TURN_CONCURRENCY_LOCK_FAILED_V36", "TURN_DETECTION_SUSPEND_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private releaseTurnConcurrencyV36(reason: string): void {
    if (!this.turnConcurrencyV36.release()) return;
    this.clearTurnConcurrencyWatchdogV36();

    const session = this as any;
    try {
      if (session.socket && session.state !== "closing" && !session.hangupStarted) {
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
      input_buffer_cleared: true,
      normal_barge_in_restored: true,
    });
  }

  protected detachTurnConcurrencyForTerminalV36(reason: string): void {
    const wasActive = this.turnConcurrencyV36.release();
    this.clearTurnConcurrencyWatchdogV36();
    (this as any).diagnostics?.checkpoint?.("TURN_CONCURRENCY_DETACHED_FOR_TERMINAL_V36", {
      reason,
      was_active: wasActive,
      vad_restored: false,
    });
  }

  private discardOverlappingTurnV36(event: RealtimeEvent): void {
    const session = this as any;
    if (event.item_id && session.socket) {
      try {
        session.send?.({ type: "conversation.item.delete", item_id: event.item_id });
      } catch (error) {
        session.diagnostics?.fail?.("TURN_CONCURRENCY_ITEM_DELETE_FAILED_V36", "OVERLAPPING_ITEM_DELETE_FAILED", {
          item_id: event.item_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
      const protectedKind = event.response?.metadata?.[PROTECTED_METADATA_KEY];
      if (id && (protectedKind === "GREETING" || protectedKind === "RECOVERY")) {
        this.protectedResponseIdsV36.add(id);
      }
    }

    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      if (!this.shouldBypassTurnConcurrencyV36(event)) {
        if (this.turnConcurrencyV36.isActive()) {
          this.discardOverlappingTurnV36(event);
          return;
        }
        this.acquireTurnConcurrencyV36();
      } else {
        (this as any).diagnostics?.checkpoint?.("TURN_CONCURRENCY_BYPASSED_V36", {
          item_id: event.item_id ?? null,
          owner: "higher_layer",
        });
      }
    }

    if (event?.type === "output_audio_buffer.started" && this.turnConcurrencyV36.isActive()) {
      const id = responseId(event);
      if (!id || !this.protectedResponseIdsV36.has(id)) {
        this.releaseTurnConcurrencyV36("normal_assistant_playback_started");
      }
    }

    if (event?.type === "output_audio_buffer.stopped") {
      const id = responseId(event);
      if (id && this.protectedResponseIdsV36.has(id)) {
        this.protectedResponseIdsV36.delete(id);
        if (this.turnConcurrencyV36.isActive()) {
          this.releaseTurnConcurrencyV36("protected_playback_completed");
        }
      }
    }

    if (event?.type === "output_audio_buffer.cleared") {
      const id = responseId(event);
      if (id) this.protectedResponseIdsV36.delete(id);
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
