import { realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { TurnConcurrencyLifecycle } from "./turn-concurrency-lifecycle.js";
import {
  decideTurnConcurrencyAcquire,
  shouldClearInputOnTurnConcurrencyRelease,
  shouldRestoreInputDetectionOnTurnConcurrencyRelease,
} from "./turn-concurrency-acquire-policy.js";
import { inputDetectionConfigRuntimeFor } from "./input-detection-config-runtime.js";
import { turnOwnershipRuntimeFor } from "./turn-ownership-runtime.js";
import { sessionTaskRuntimeFor } from "./session-task-runtime.js";

const TURN_LOCK_WATCHDOG_MS = 30_000;

export type TurnConcurrencyEvent = RealtimeProviderEvent;

function hasUsableTranscript(value: unknown): boolean {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().length > 0 : false;
}

function isProtectedKind(kind: string): boolean {
  return kind === "GREETING" || kind === "RECOVERY" || kind === "PRESENCE";
}

export class TurnConcurrencyCoordinator {
  private lifecycle = new TurnConcurrencyLifecycle();
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private protectedResponseIds = new Set<string>();
  private normalPlaybackActive = false;
  private latestCallerSpeechItemId: string | null = null;

  isActive(): boolean { return this.lifecycle.isActive(); }

  private acquire(session: any): void {
    if (!this.lifecycle.acquire()) return;
    if (conversationLifecyclePortFor(session).isTerminal()) { this.lifecycle.release(); return; }
    try {
      realtimeCommandPortFor(session).suspendInputDetection();
      this.armWatchdog(session);
      session.diagnostics?.checkpoint?.("TURN_CONCURRENCY_LOCK_ACQUIRED_V36", {
        source: "usable_completed_user_transcript",
        turn_detection_suspended: true,
        owner: "turn_concurrency_coordinator",
      });
    } catch (error) {
      this.lifecycle.release();
      session.diagnostics?.fail?.("TURN_CONCURRENCY_LOCK_FAILED_V36", "TURN_DETECTION_SUSPEND_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  release(session: any, reason: string): void {
    if (!this.lifecycle.release()) return;
    this.clearWatchdog();
    const clearInput = shouldClearInputOnTurnConcurrencyRelease(reason);
    const restoreInputDetection = shouldRestoreInputDetectionOnTurnConcurrencyRelease(reason);
    try {
      if (session.socket && !conversationLifecyclePortFor(session).isTerminal()) {
        const realtime = realtimeCommandPortFor(session);
        if (clearInput) realtime.clearInput();
        if (restoreInputDetection) realtime.restoreInputDetection(inputDetectionConfigRuntimeFor(session).get());
      }
    } catch (error) {
      session.diagnostics?.fail?.("TURN_CONCURRENCY_RELEASE_FAILED_V36", "TURN_DETECTION_RESTORE_FAILED", {
        reason,
        restore_input_detection_requested: restoreInputDetection,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    session.diagnostics?.checkpoint?.("TURN_CONCURRENCY_LOCK_RELEASED_V36", {
      reason,
      input_buffer_cleared: clearInput,
      immediate_barge_in_audio_preserved: !clearInput,
      input_detection_restored_by_v36: restoreInputDetection,
      input_detection_owner: restoreInputDetection ? "turn_concurrency_coordinator" : "response_coordinator",
      normal_barge_in_restored: !restoreInputDetection,
    });
  }

  detachForTerminal(session: any, reason: string): void {
    const wasActive = this.lifecycle.release();
    this.clearWatchdog();
    this.normalPlaybackActive = false;
    this.latestCallerSpeechItemId = null;
    session.diagnostics?.checkpoint?.("TURN_CONCURRENCY_DETACHED_FOR_TERMINAL_V36", {
      reason, was_active: wasActive, vad_restored: false, owner: "turn_concurrency_coordinator",
    });
  }

  private discardOverlappingTurn(session: any, itemId: string | undefined, usable: boolean): void {
    if (itemId && session.socket) {
      try { realtimeCommandPortFor(session).discardInputItem(itemId); }
      catch (error) {
        session.diagnostics?.fail?.("TURN_CONCURRENCY_ITEM_DELETE_FAILED_V36", "OVERLAPPING_ITEM_DELETE_FAILED", {
          item_id: itemId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    session.diagnostics?.checkpoint?.("TURN_CONCURRENCY_OVERLAPPING_TURN_DROPPED_V36", {
      item_id: itemId ?? null,
      active_turn_age_ms: this.lifecycle.ageMs(),
      transcript_usable: usable,
      semantic_processing_unchanged: true,
      lifecycle_ownership_unchanged: true,
    });
  }

  private armWatchdog(session: any): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      sessionTaskRuntimeFor(session).enqueue("turn_concurrency_watchdog_v36", () => {
        if (!this.lifecycle.isActive()) return;
        session.diagnostics?.fail?.("TURN_CONCURRENCY_WATCHDOG_V36", "TURN_LOCK_TERMINAL_EVENT_MISSING", {
          watchdog_ms: TURN_LOCK_WATCHDOG_MS,
          active_turn_age_ms: this.lifecycle.ageMs(),
          recovery: "terminal_fail_closed",
        });
        // Never reopen VAD while the original semantic/business operation may
        // still be in flight. A watchdog expiry is an exceptional loss of the
        // turn's terminal boundary, so preserve exclusivity and terminate the
        // conversation through the lifecycle authority instead of admitting a
        // second caller turn over unknown state.
        conversationLifecyclePortFor(session).confirmEndCall(
          "turn_concurrency_watchdog",
          "turn_concurrency_coordinator",
        );
        this.detachForTerminal(session, "watchdog_terminal_fail_closed");
      });
    }, TURN_LOCK_WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (!this.watchdog) return;
    clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  observe(session: any, event: RealtimeProviderEvent | null): boolean {
    if (!event) return false;

    if (event.type === "CALLER_SPEECH_STARTED" && event.itemId) {
      this.latestCallerSpeechItemId = event.itemId;
    }

    if (event.type === "ASSISTANT_RESPONSE_STARTED") {
      const id = event.responseId ?? null;
      if (id && isProtectedKind(event.kind)) this.protectedResponseIds.add(id);
    }

    if (event.type === "CALLER_TRANSCRIPT_COMPLETED") {
      const usable = hasUsableTranscript(event.transcript);
      const higherLayerOwns = turnOwnershipRuntimeFor(session).ownsSemanticItem(event.itemId);
      const newerCallerSpeechObserved = Boolean(
        event.itemId && this.latestCallerSpeechItemId && event.itemId !== this.latestCallerSpeechItemId,
      );
      if (!higherLayerOwns && this.lifecycle.isActive()) {
        this.discardOverlappingTurn(session, event.itemId, usable);
        return true;
      }
      const decision = decideTurnConcurrencyAcquire({
        usableTranscript: usable,
        normalPlaybackActive: this.normalPlaybackActive,
        higherLayerOwns,
        newerCallerSpeechObserved,
      });
      if (decision === "ACQUIRE") this.acquire(session);
      else if (decision === "BYPASS_NEWER_CALLER_SPEECH") {
        session.diagnostics?.checkpoint?.("TURN_CONCURRENCY_OLDER_SPLIT_FRAGMENT_DEFERRED_V36", {
          item_id: event.itemId ?? null,
          latest_caller_speech_item_id: this.latestCallerSpeechItemId,
          ownership_acquired: false, turn_detection_suspended: false,
          semantic_pipeline_entered: false, timing_heuristic: false,
        });
        return true;
      } else if (decision === "BYPASS_UNUSABLE") {
        session.diagnostics?.checkpoint?.("TURN_CONCURRENCY_UNUSABLE_TRANSCRIPT_BYPASSED_V36", {
          item_id: event.itemId ?? null, ownership_acquired: false, turn_detection_suspended: false,
        });
      } else if (decision === "BYPASS_PLAYBACK_ALREADY_STARTED") {
        session.diagnostics?.checkpoint?.("TURN_CONCURRENCY_LATE_TRANSCRIPT_BYPASSED_V36", {
          item_id: event.itemId ?? null, ownership_acquired: false,
          turn_detection_suspended: false, normal_playback_active: true, release_boundary_already_passed: true,
        });
      } else {
        session.diagnostics?.checkpoint?.("TURN_CONCURRENCY_BYPASSED_V36", {
          item_id: event.itemId ?? null,
          owner: "turn_ownership_runtime",
        });
      }
    }

    if (event.type === "ASSISTANT_AUDIO_STARTED") {
      const id = event.responseId ?? null;
      const protectedPlayback = isProtectedKind(event.kind) || Boolean(id && this.protectedResponseIds.has(id));
      if (!protectedPlayback) {
        this.normalPlaybackActive = true;
        if (this.lifecycle.isActive()) this.release(session, "normal_assistant_playback_started");
      }
    }

    if (event.type === "ASSISTANT_AUDIO_STOPPED") {
      const id = event.responseId ?? null;
      const protectedPlayback = isProtectedKind(event.kind) || Boolean(id && this.protectedResponseIds.has(id));
      if (!protectedPlayback) this.normalPlaybackActive = false;
      if (protectedPlayback) {
        if (id) this.protectedResponseIds.delete(id);
        if (this.lifecycle.isActive()) this.release(session, "protected_playback_completed");
      }
    }

    if (event.type === "ASSISTANT_AUDIO_CLEARED") {
      const id = event.responseId ?? null;
      this.normalPlaybackActive = false;
      if (id) this.protectedResponseIds.delete(id);
    }

    return false;
  }
}

const coordinators = new WeakMap<object, TurnConcurrencyCoordinator>();
export function turnConcurrencyCoordinatorFor(session: object): TurnConcurrencyCoordinator {
  let coordinator = coordinators.get(session);
  if (!coordinator) { coordinator = new TurnConcurrencyCoordinator(); coordinators.set(session, coordinator); }
  return coordinator;
}
