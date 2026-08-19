import { CallSession as CallSessionV39 } from "./call-session-v39";
import {
  initialResponseOwnerSnapshot,
  reduceResponseOwner,
  type ResponseOwnerEffect,
  type ResponseOwnerEvent,
  type ResponseOwnerSnapshot,
} from "./realtime-response-owner";
import { decideResponseOwnerEmission, type ResponseOwnerEmissionMode } from "./response-owner-emission-policy";
import { applyBargeInSemanticDecision } from "./response-owner-barge-in-decision";
import {
  decideConfirmedBargeInPromotion,
  decideDeferredBargeInTranscriptRoute,
} from "./barge-in-semantic-authority";
import {
  BARGE_IN_METADATA_PURPOSE,
  buildBargeInClassifierRequest,
  parseBargeInDecision,
} from "./barge-in-confirmation";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";

const BaseConstructor = CallSessionV39 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV39.prototype as any;
const RESPONSE_OWNER_EMISSION_MODE: ResponseOwnerEmissionMode = "active";

type PendingBargeIn = {
  itemId: string;
  transcript: string;
  originalData: unknown;
};

type DeferredConfirmedBargeIn = {
  source: PendingBargeIn;
  targetItemId: string;
  postSemanticEffects: ResponseOwnerEffect[];
};

type TurnConcurrencyCompatibilityEvent = { item_id?: string };

function usableTranscript(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
}

function providerResponseId(event: RealtimeProviderEvent): string | null {
  return "responseId" in event && typeof event.responseId === "string" ? event.responseId : null;
}

/**
 * Rebuild v40: single authority for classified normal-speech barge-in above the
 * known-good v39 baseline.
 *
 * Provider wire events are translated before this layer sees them. The only raw
 * compatibility seam left is the v36 inherited bypass hook, because v36 owns that
 * legacy method signature and is deliberately outside Gate B.
 *
 * Invariants:
 * - raw VAD never authorizes cancellation or a new semantic response;
 * - protected greeting/recovery/handoff speech is never made interruptible here;
 * - response start alone never opens barge-in; real assistant playback does;
 * - playback start opens semantic ownership before lower layers process the same event;
 * - listening ownership is response-scoped: playback clear invalidates the old
 *   assumption and the next playback must reassert non-interrupting listening;
 * - completed caller speech is classified out-of-conversation as INTERRUPT/IGNORE;
 * - an unclassifiable candidate resolves immediately as IGNORE;
 * - confirmed barge-in has one lifecycle owner: v40. v36 explicitly yields the
 *   classified source item when that exact item enters the semantic pipeline;
 * - a classified older fragment can interrupt playback, but cannot create a
 *   response after a newer caller speech item has already started;
 * - split-utterance ordering is item/event based and never uses a timing window;
 * - IGNORE is non-destructive and never synthesizes a replacement continuation;
 * - INTERRUPT never waits for response completion.
 */
export class CallSession extends BaseConstructor {
  private responseOwnerV40: ResponseOwnerSnapshot = initialResponseOwnerSnapshot();
  private pendingBargeInV40: PendingBargeIn | null = null;
  private classifierByResponseV40 = new Map<string, PendingBargeIn>();
  private protectedResponseIdsV40 = new Set<string>();
  private listeningResponseIdV40: string | null = null;
  private playbackBargeInWindowV40 = false;
  private v40OwnedSemanticItemId: string | null = null;
  private latestCallerSpeechItemIdV40: string | null = null;
  private latestCompletedCallerItemIdV40: string | null = null;
  private deferredConfirmedBargeInV40: DeferredConfirmedBargeIn | null = null;

  protected shouldBypassTurnConcurrencyV36(event: TurnConcurrencyCompatibilityEvent): boolean {
    return Boolean(this.v40OwnedSemanticItemId && event.item_id === this.v40OwnedSemanticItemId);
  }

  protected observeCallerSpeechStartedV40(itemId: string | null | undefined, source = "v40_runtime"): void {
    if (!itemId) return;
    const previousItemId = this.latestCallerSpeechItemIdV40;
    this.latestCallerSpeechItemIdV40 = itemId;

    const deferred = this.deferredConfirmedBargeInV40;
    if (deferred && deferred.targetItemId !== itemId) {
      const previousTargetItemId = deferred.targetItemId;
      deferred.targetItemId = itemId;
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_DEFERRED_TARGET_ADVANCED_V40_REBUILD", {
        classifier_source_item_id: deferred.source.itemId,
        previous_target_item_id: previousTargetItemId,
        target_item_id: itemId,
        observation_source: source,
        timer_used: false,
      });
    } else if (previousItemId !== itemId && this.pendingBargeInV40 && this.pendingBargeInV40.itemId !== itemId) {
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_NEWER_SPEECH_OBSERVED_V40_REBUILD", {
        classifier_source_item_id: this.pendingBargeInV40.itemId,
        previous_item_id: previousItemId,
        latest_item_id: itemId,
        observation_source: source,
        timer_used: false,
      });
    }
  }

  private reportOwnerEffectsV40(effects: ResponseOwnerEffect[]): void {
    for (const effect of effects) {
      if (effect.type === "response_ownership_conflict") {
        (this as any).diagnostics?.fail?.(
          "RESPONSE_OWNERSHIP_CONFLICT_V40_REBUILD",
          "MULTIPLE_ACTIVE_REALTIME_RESPONSES",
          {
            previous_response_id: effect.previousResponseId,
            new_response_id: effect.newResponseId,
            reconciled_to_newest_server_response: true,
            runtime_effects_executed: false,
          },
        );
      }
    }
  }

  private reconcileOwnerEventV40(event: ResponseOwnerEvent): ResponseOwnerEffect[] {
    const previous = this.responseOwnerV40;
    const result = reduceResponseOwner(previous, event);
    this.responseOwnerV40 = result.snapshot;
    this.reportOwnerEffectsV40(result.effects);

    const emission = decideResponseOwnerEmission(result.effects, RESPONSE_OWNER_EMISSION_MODE);
    (this as any).diagnostics?.checkpoint?.("RESPONSE_OWNER_RECONCILED_V40_REBUILD", {
      event_type: event.type,
      previous_state: previous.state,
      next_state: result.snapshot.state,
      previous_active_response_id: previous.activeResponseId,
      active_response_id: result.snapshot.activeResponseId,
      playback_cleared: result.snapshot.playbackCleared,
      caller_response_pending: result.snapshot.callerResponsePending,
      resume_after_active_done: result.snapshot.resumeAfterActiveDone,
      reducer_effects: result.effects.map((effect) => effect.type),
      executable_effects: emission.executable.map((effect) => effect.type),
      observed_only_effects: emission.observedOnly.map((effect) => effect.type),
      emission_mode: RESPONSE_OWNER_EMISSION_MODE,
    });
    this.executePostSemanticEffectsV40(emission.executable);
    return emission.executable;
  }

  private reportStaleDoneV40(id: string): void {
    const activeId = this.responseOwnerV40.activeResponseId;
    if (!activeId || activeId === id) return;
    (this as any).diagnostics?.checkpoint?.("STALE_RESPONSE_DONE_IGNORED_V40_REBUILD", {
      stale_response_id: id,
      active_response_id: activeId,
      active_response_preserved: true,
    });
  }

  private setNormalListeningV40(responseIdValue: string): void {
    if (this.listeningResponseIdV40 === responseIdValue) return;
    const session = this as any;
    if (!session.socket || session.state === "closing" || session.hangupStarted) return;
    realtimeCommandPortFor(session).beginNonInterruptingListening(session.tenantVadV35 ?? {});
    this.listeningResponseIdV40 = responseIdValue;
    session.diagnostics?.checkpoint?.("BARGE_IN_LISTENING_ACTIVE_V40_REBUILD", {
      response_id: responseIdValue,
      automatic_interrupt: false,
      automatic_response: false,
      owner_state: this.responseOwnerV40.state,
      playback_window_active: this.playbackBargeInWindowV40,
      provider_command_port: true,
    });
  }

  private invalidateNormalListeningV40(reason: string, responseIdValue: string | null): void {
    const previousResponseId = this.listeningResponseIdV40;
    this.listeningResponseIdV40 = null;
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_LISTENING_INVALIDATED_V40_REBUILD", {
      reason,
      response_id: responseIdValue,
      previous_listening_response_id: previousResponseId,
      vad_restored: false,
      next_playback_must_reassert: true,
    });
  }

  private restoreNormalVadV40(reason: string): void {
    if (!this.listeningResponseIdV40) return;
    const session = this as any;
    this.listeningResponseIdV40 = null;
    if (!session.socket || session.state === "closing" || session.hangupStarted) return;
    realtimeCommandPortFor(session).restoreInputDetection(session.tenantVadV35 ?? {});
    session.diagnostics?.checkpoint?.("BARGE_IN_LISTENING_RELEASED_V40_REBUILD", { reason, provider_command_port: true });
  }

  private requestClassifierV40(
    event: Extract<RealtimeProviderEvent, { type: "CALLER_TRANSCRIPT_COMPLETED" }>,
    data: unknown,
  ): boolean {
    if (this.responseOwnerV40.state !== "BARGE_IN_CLASSIFYING") return false;
    const itemId = typeof event.itemId === "string" ? event.itemId : "";
    const transcript = usableTranscript(event.transcript);
    if (!itemId || !transcript) return false;

    if (this.pendingBargeInV40) {
      const isNewestStartedItem =
        itemId !== this.pendingBargeInV40.itemId &&
        itemId === this.latestCallerSpeechItemIdV40;
      if (isNewestStartedItem) {
        (this as any).diagnostics?.checkpoint?.("BARGE_IN_NEWER_FRAGMENT_TRANSCRIPT_FORWARDED_V40_REBUILD", {
          classifier_source_item_id: this.pendingBargeInV40.itemId,
          newer_item_id: itemId,
          semantic_pipeline_allowed: true,
          classifier_still_pending: true,
          input_item_deleted: false,
          timer_used: false,
        });
        return false;
      }

      try { realtimeCommandPortFor(this as any).discardInputItem(itemId); } catch { /* best effort */ }
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_EXTRA_CANDIDATE_DROPPED_V40_REBUILD", {
        item_id: itemId,
        pending_item_id: this.pendingBargeInV40.itemId,
      });
      return true;
    }

    const pending: PendingBargeIn = { itemId, transcript, originalData: data };
    this.pendingBargeInV40 = pending;
    realtimeCommandPortFor(this as any).requestTextDecision(buildBargeInClassifierRequest(transcript, itemId));
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD", {
      item_id: itemId,
      transcript_length: transcript.length,
      active_response_id: this.responseOwnerV40.activeResponseId,
      playback_cleared: this.responseOwnerV40.playbackCleared,
      provider_command_port: true,
    });
    return true;
  }

  private executePreSemanticEffectsV40(effects: ResponseOwnerEffect[]): void {
    const realtime = realtimeCommandPortFor(this as any);
    for (const effect of effects) {
      if (effect.type === "cancel_response") {
        realtime.cancelResponse(effect.responseId);
      } else if (effect.type === "clear_playback") {
        realtime.clearPlayback();
      }
    }
  }

  private executePostSemanticEffectsV40(effects: ResponseOwnerEffect[]): void {
    const realtime = realtimeCommandPortFor(this as any);
    for (const effect of effects) {
      if (effect.type === "create_caller_response") {
        realtime.createDefaultResponse();
      } else if (effect.type === "resume_assistant") {
        realtime.speak({
          tools: "DISABLED",
          instructions:
            "Continúa inmediatamente la respuesta que estabas pronunciando antes de la interrupción acústica. " +
            "No menciones la interrupción, no vuelvas a empezar desde el principio y completa únicamente la información pendiente.",
        });
      }
    }
  }

  private cancelledResponseIdV40(effects: ResponseOwnerEffect[]): string | null {
    const cancelled = effects.find(
      (effect): effect is Extract<ResponseOwnerEffect, { type: "cancel_response" }> => effect.type === "cancel_response",
    );
    return cancelled?.responseId ?? null;
  }

  private reportConfirmedBargeInV40(options: {
    classifierSourceItemId: string;
    semanticItemId: string;
    effects: ResponseOwnerEffect[];
    v36TurnLockBypassed: boolean;
    deferredToNewerSpeech: boolean;
    fallbackFromUnusableNewer?: boolean;
  }): void {
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_CONFIRMED_V40_REBUILD", {
      item_id: options.classifierSourceItemId,
      semantic_item_id: options.semanticItemId,
      classifier_source_item_id: options.classifierSourceItemId,
      cancelled_response_id: this.cancelledResponseIdV40(options.effects),
      playback_was_already_cleared: this.responseOwnerV40.playbackCleared,
      promoted_to_v39_semantic_pipeline: true,
      v36_turn_lock_bypassed: options.v36TurnLockBypassed,
      response_done_gate: false,
      provider_neutral_classifier: true,
      deferred_to_newer_speech: options.deferredToNewerSpeech,
      fallback_from_unusable_newer: options.fallbackFromUnusableNewer ?? false,
    });
  }

  private async promoteConfirmedSourceV40(
    pending: PendingBargeIn,
    effects: ResponseOwnerEffect[],
    options: { classifierSourceItemId?: string; fallbackFromUnusableNewer?: boolean } = {},
  ): Promise<void> {
    this.v40OwnedSemanticItemId = pending.itemId;
    try {
      await BasePrototype.handleRealtimeMessage.call(this, pending.originalData);
    } finally {
      this.v40OwnedSemanticItemId = null;
    }
    this.executePostSemanticEffectsV40(effects);
    const classifierSourceItemId = options.classifierSourceItemId ?? pending.itemId;
    this.reportConfirmedBargeInV40({
      classifierSourceItemId,
      semanticItemId: pending.itemId,
      effects,
      v36TurnLockBypassed: true,
      deferredToNewerSpeech: classifierSourceItemId !== pending.itemId,
      fallbackFromUnusableNewer: options.fallbackFromUnusableNewer,
    });
  }

  private async handleDeferredConfirmedTranscriptV40(
    event: Extract<RealtimeProviderEvent, { type: "CALLER_TRANSCRIPT_COMPLETED" }>,
    data: unknown,
  ): Promise<boolean> {
    const deferred = this.deferredConfirmedBargeInV40;
    if (!deferred) return false;

    const itemId = typeof event.itemId === "string" ? event.itemId : null;
    const transcript = usableTranscript(event.transcript);
    const route = decideDeferredBargeInTranscriptRoute(
      deferred.targetItemId,
      itemId,
      Boolean(transcript),
    );

    if (route === "WAIT_FOR_LATEST") {
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_DEFERRED_INTERMEDIATE_TRANSCRIPT_SUPPRESSED_V40_REBUILD", {
        classifier_source_item_id: deferred.source.itemId,
        target_item_id: deferred.targetItemId,
        completed_item_id: itemId,
        semantic_pipeline_entered: false,
        input_item_deleted: false,
        timer_used: false,
      });
      return true;
    }

    this.deferredConfirmedBargeInV40 = null;

    if (route === "FALLBACK_SOURCE") {
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_DEFERRED_LATEST_UNUSABLE_FALLBACK_V40_REBUILD", {
        classifier_source_item_id: deferred.source.itemId,
        target_item_id: deferred.targetItemId,
        completed_item_id: itemId,
        fallback_item_id: deferred.source.itemId,
        timer_used: false,
      });
      await this.promoteConfirmedSourceV40(deferred.source, deferred.postSemanticEffects, {
        classifierSourceItemId: deferred.source.itemId,
        fallbackFromUnusableNewer: true,
      });
      return true;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
    this.executePostSemanticEffectsV40(deferred.postSemanticEffects);
    this.reportConfirmedBargeInV40({
      classifierSourceItemId: deferred.source.itemId,
      semanticItemId: itemId as string,
      effects: deferred.postSemanticEffects,
      v36TurnLockBypassed: false,
      deferredToNewerSpeech: true,
    });
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_DEFERRED_LATEST_FRAGMENT_PROMOTED_V40_REBUILD", {
      classifier_source_item_id: deferred.source.itemId,
      item_id: itemId,
      target_item_id: deferred.targetItemId,
      semantic_pipeline_entered: true,
      v36_turn_lock_bypassed: false,
      response_creation_released_after_latest_transcript: true,
      timer_used: false,
    });
    return true;
  }

  private resolveUnclassifiableCandidateV40(
    event: Extract<RealtimeProviderEvent, { type: "CALLER_TRANSCRIPT_COMPLETED" }>,
  ): boolean {
    if (this.responseOwnerV40.state !== "BARGE_IN_CLASSIFYING") return false;
    const itemId = typeof event.itemId === "string" ? event.itemId : "";
    const transcript = usableTranscript(event.transcript);
    if (itemId && transcript) return false;

    const result = applyBargeInSemanticDecision(this.responseOwnerV40, "IGNORE");
    if (!result.accepted) return false;
    this.responseOwnerV40 = result.snapshot;
    const emission = decideResponseOwnerEmission(result.effects, RESPONSE_OWNER_EMISSION_MODE);
    this.reportOwnerEffectsV40(result.effects);

    if (itemId) {
      try { realtimeCommandPortFor(this as any).discardInputItem(itemId); } catch { /* best effort */ }
    }
    this.executePostSemanticEffectsV40(emission.executable);
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_UNCLASSIFIABLE_IGNORED_V40_REBUILD", {
      item_id_present: Boolean(itemId),
      usable_transcript_present: Boolean(transcript),
      playback_cleared: result.snapshot.playbackCleared,
      semantic_pipeline_entered: false,
      resolved_without_watchdog: true,
      provider_neutral_event: true,
    });
    return true;
  }

  private async finalizeClassifierV40(responseIdValue: string, text: unknown): Promise<void> {
    const pending = this.classifierByResponseV40.get(responseIdValue);
    if (!pending) return;
    this.classifierByResponseV40.delete(responseIdValue);
    if (this.pendingBargeInV40?.itemId === pending.itemId) this.pendingBargeInV40 = null;

    const decision = parseBargeInDecision(text);
    const result = applyBargeInSemanticDecision(this.responseOwnerV40, decision);
    if (!result.accepted) {
      (this as any).diagnostics?.fail?.("BARGE_IN_DECISION_REJECTED_V40_REBUILD", "OWNER_NOT_CLASSIFYING", {
        item_id: pending.itemId,
        decision,
        owner_state: this.responseOwnerV40.state,
      });
      return;
    }

    this.responseOwnerV40 = result.snapshot;
    const emission = decideResponseOwnerEmission(result.effects, RESPONSE_OWNER_EMISSION_MODE);
    this.reportOwnerEffectsV40(result.effects);

    if (decision === "IGNORE") {
      try { realtimeCommandPortFor(this as any).discardInputItem(pending.itemId); } catch { /* best effort */ }
      this.executePostSemanticEffectsV40(emission.executable);
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_IGNORED_V40_REBUILD", {
        item_id: pending.itemId,
        playback_cleared: result.snapshot.playbackCleared,
        active_response_id: result.snapshot.activeResponseId,
        resume_after_active_done: result.snapshot.resumeAfterActiveDone,
        semantic_pipeline_entered: false,
      });
      return;
    }

    this.executePreSemanticEffectsV40(emission.executable);
    const promotionRoute = decideConfirmedBargeInPromotion(pending.itemId, this.latestCallerSpeechItemIdV40);

    if (promotionRoute === "DEFER_TO_NEWER_SPEECH" && this.latestCallerSpeechItemIdV40) {
      const targetItemId = this.latestCallerSpeechItemIdV40;
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_CONFIRMED_DEFERRED_TO_NEWER_SPEECH_V40_REBUILD", {
        classifier_source_item_id: pending.itemId,
        target_item_id: targetItemId,
        target_transcript_already_completed: this.latestCompletedCallerItemIdV40 === targetItemId,
        cancelled_response_id: this.cancelledResponseIdV40(result.effects),
        response_creation_deferred: this.latestCompletedCallerItemIdV40 !== targetItemId,
        timer_used: false,
      });

      if (this.latestCompletedCallerItemIdV40 === targetItemId) {
        this.executePostSemanticEffectsV40(emission.executable);
        this.reportConfirmedBargeInV40({
          classifierSourceItemId: pending.itemId,
          semanticItemId: targetItemId,
          effects: emission.executable,
          v36TurnLockBypassed: false,
          deferredToNewerSpeech: true,
        });
        (this as any).diagnostics?.checkpoint?.("BARGE_IN_NEWER_COMPLETED_FRAGMENT_RESPONSE_RELEASED_V40_REBUILD", {
          classifier_source_item_id: pending.itemId,
          item_id: targetItemId,
          semantic_pipeline_already_entered: true,
          response_creation_released: true,
          v36_turn_lock_bypassed: false,
          timer_used: false,
        });
        return;
      }

      this.deferredConfirmedBargeInV40 = {
        source: pending,
        targetItemId,
        postSemanticEffects: emission.executable,
      };
      return;
    }

    await this.promoteConfirmedSourceV40(pending, emission.executable);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const providerEvents = adaptRealtimeProviderEvents(data);

    for (const event of providerEvents) {
      const id = providerResponseId(event);
      const isClassifierResponse =
        event.type === "ASSISTANT_RESPONSE_STARTED" && event.purpose === BARGE_IN_METADATA_PURPOSE;

      if (isClassifierResponse) {
        const sourceItemId = event.sourceItemId ?? "";
        const pending = this.pendingBargeInV40;
        if (id && pending && pending.itemId === sourceItemId) {
          this.classifierByResponseV40.set(id, pending);
          (this as any).diagnostics?.checkpoint?.("BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD", {
            response_id: id,
            item_id: sourceItemId,
            provider_neutral_event: event.type,
          });
        }
        return;
      }

      if (event.type === "TEXT_DECISION_COMPLETED" && id && this.classifierByResponseV40.has(id)) {
        await this.finalizeClassifierV40(id, event.text);
        return;
      }

      if (event.type === "ASSISTANT_RESPONSE_COMPLETED" && id && this.classifierByResponseV40.has(id)) {
        await this.finalizeClassifierV40(id, "IGNORE");
        return;
      }

      if (event.type === "CALLER_TRANSCRIPT_COMPLETED") {
        const completedItemId = typeof event.itemId === "string" ? event.itemId : null;
        if (completedItemId) this.latestCompletedCallerItemIdV40 = completedItemId;
        if (await this.handleDeferredConfirmedTranscriptV40(event, data)) return;
        if (this.resolveUnclassifiableCandidateV40(event)) return;
        if (this.requestClassifierV40(event, data)) return;
      }

      if (event.type === "ASSISTANT_RESPONSE_STARTED" && id) {
        if (event.kind !== "NORMAL") this.protectedResponseIdsV40.add(id);
        this.reconcileOwnerEventV40({ type: "assistant_response_started", responseId: id });
      } else if (event.type === "ASSISTANT_RESPONSE_COMPLETED" && id) {
        this.reportStaleDoneV40(id);
        this.reconcileOwnerEventV40({ type: "assistant_response_done", responseId: id });
        this.protectedResponseIdsV40.delete(id);
      } else if (event.type === "ASSISTANT_AUDIO_CLEARED") {
        this.reconcileOwnerEventV40({ type: "assistant_playback_cleared" });
        if (id) this.protectedResponseIdsV40.delete(id);
        this.playbackBargeInWindowV40 = false;
        this.invalidateNormalListeningV40("assistant_playback_cleared", id);
      } else if (event.type === "CALLER_SPEECH_STARTED") {
        this.observeCallerSpeechStartedV40(event.itemId ?? null);
        if (this.playbackBargeInWindowV40) {
          this.reconcileOwnerEventV40({ type: "caller_speech_started" });
        }
      }

      const normalPlaybackStarting =
        event.type === "ASSISTANT_AUDIO_STARTED" &&
        Boolean(id) &&
        !this.protectedResponseIdsV40.has(id as string) &&
        this.responseOwnerV40.state === "ASSISTANT_ACTIVE";

      if (normalPlaybackStarting) {
        this.playbackBargeInWindowV40 = true;
        this.latestCallerSpeechItemIdV40 = null;
        this.latestCompletedCallerItemIdV40 = null;
        (this as any).diagnostics?.checkpoint?.("BARGE_IN_PLAYBACK_WINDOW_OPENED_V40_REBUILD", {
          response_id: id,
          authority_from: "assistant_playback_started",
          opened_before_lower_layers: true,
          provider_neutral_event: event.type,
        });
      } else if (event.type === "ASSISTANT_AUDIO_STOPPED") {
        this.playbackBargeInWindowV40 = false;
      }

      if ((this as any).state === "closing" || (this as any).hangupStarted) {
        this.reconcileOwnerEventV40({ type: "terminal" });
        this.pendingBargeInV40 = null;
        this.classifierByResponseV40.clear();
        this.protectedResponseIdsV40.clear();
        this.listeningResponseIdV40 = null;
        this.playbackBargeInWindowV40 = false;
        this.v40OwnedSemanticItemId = null;
        this.latestCallerSpeechItemIdV40 = null;
        this.latestCompletedCallerItemIdV40 = null;
        this.deferredConfirmedBargeInV40 = null;
      }

      await BasePrototype.handleRealtimeMessage.call(this, data);

      if (normalPlaybackStarting && id) {
        this.setNormalListeningV40(id);
      } else if (event.type === "ASSISTANT_AUDIO_STOPPED") {
        if (id) this.protectedResponseIdsV40.delete(id);
        this.restoreNormalVadV40("assistant_playback_stopped");
      }
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
