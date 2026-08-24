import { CallSession as CallSessionV39 } from "./call-session-v39";
import type { ResponseOwnerEffect, ResponseOwnerEvent } from "./realtime-response-owner";
import {
  decideConfirmedBargeInPromotion,
  decideDeferredBargeInTranscriptRoute,
  decideIgnoredBargeInPlaybackRecovery,
} from "./barge-in-semantic-authority";
import {
  BARGE_IN_METADATA_PURPOSE,
  buildBargeInClassifierRequest,
  parseBargeInDecision,
} from "./barge-in-confirmation";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import { semanticDecisionPortFor } from "./semantic-decision-runtime.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import { responseCoordinatorFor } from "./response-coordinator.js";
import { turnOwnershipRuntimeFor } from "./turn-ownership-runtime.js";
import { inputDetectionConfigRuntimeFor } from "./input-detection-config-runtime.js";
import { bargeInOrderingRuntimeFor } from "./barge-in-ordering-runtime.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { executeCallerTurnDisposition } from "./caller-turn-disposition-execution.js";
import { sessionTaskRuntimeFor } from "./session-task-runtime.js";
import {
  installRealtimeProviderEventIngress,
  trustedRealtimeProviderEventBatch,
  type RealtimeProviderEventIngress,
} from "./realtime-provider-event-ingress-runtime.js";

const BaseConstructor = CallSessionV39 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV39.prototype as any;
const PROVIDER_CLEAR_LIVENESS_MESSAGE = "Perdona, parece que se cortó el audio. Te escucho.";

type PendingBargeIn = { itemId: string; transcript: string; originalData: unknown };
type DeferredConfirmedBargeIn = {
  source: PendingBargeIn;
  targetItemId: string;
  postSemanticEffects: ResponseOwnerEffect[];
};

function usableTranscript(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
}
function providerResponseId(event: RealtimeProviderEvent): string | null {
  return "responseId" in event && typeof event.responseId === "string" ? event.responseId : null;
}

/**
 * Barge-in policy adapter. Response state, semantic turn ownership, caller item
 * ordering and input configuration are owned by version-neutral coordinators.
 */
export class CallSession extends BaseConstructor {
  private readonly providerEventIngressV40: RealtimeProviderEventIngress = (events) => {
    const tasks = sessionTaskRuntimeFor(this);
    for (const event of events) {
      tasks.enqueue("provider_event_ingress_v40", () =>
        this.handleRealtimeMessage(trustedRealtimeProviderEventBatch([event])),
      );
    }
    return tasks.whenIdle();
  };
  private pendingBargeInV40: PendingBargeIn | null = null;
  private classifierByResponseV40 = new Map<string, PendingBargeIn>();
  private protectedResponseIdsV40 = new Set<string>();
  private listeningResponseIdV40: string | null = null;
  private playbackBargeInWindowV40 = false;
  private deferredConfirmedBargeInV40: DeferredConfirmedBargeIn | null = null;
  private providerClearedPlaybackBeforeDecisionV40 = false;
  private clientClearRequestedV40 = false;

  constructor(...args: any[]) {
    super(...args);
    installRealtimeProviderEventIngress(this, this.providerEventIngressV40);
  }

  private observeCallerSpeechStartedV40(itemId: string | null | undefined, source = "v40_runtime"): void {
    if (!itemId) return;
    const ordering = bargeInOrderingRuntimeFor(this);
    const { previous } = ordering.observeSpeechStarted(itemId);
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
    } else if (previous !== itemId && this.pendingBargeInV40 && this.pendingBargeInV40.itemId !== itemId) {
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_NEWER_SPEECH_OBSERVED_V40_REBUILD", {
        classifier_source_item_id: this.pendingBargeInV40.itemId,
        previous_item_id: previous,
        latest_item_id: itemId,
        observation_source: source,
        timer_used: false,
      });
    }
  }

  private reportOwnerEffectsV40(effects: readonly ResponseOwnerEffect[]): void {
    for (const effect of effects) {
      if (effect.type === "response_ownership_conflict") {
        (this as any).diagnostics?.fail?.("RESPONSE_OWNERSHIP_CONFLICT_V40_REBUILD", "MULTIPLE_ACTIVE_REALTIME_RESPONSES", {
          previous_response_id: effect.previousResponseId,
          new_response_id: effect.newResponseId,
          reconciled_to_newest_server_response: true,
          runtime_effects_executed: false,
          owner: "response_coordinator",
        });
      }
    }
  }

  private reconcileOwnerEventV40(event: ResponseOwnerEvent): ResponseOwnerEffect[] {
    const result = responseCoordinatorFor(this).reconcile(event);
    this.reportOwnerEffectsV40(result.effects);
    (this as any).diagnostics?.checkpoint?.("RESPONSE_OWNER_RECONCILED_V40_REBUILD", {
      event_type: event.type,
      previous_state: result.previous.state,
      next_state: result.snapshot.state,
      previous_active_response_id: result.previous.activeResponseId,
      active_response_id: result.snapshot.activeResponseId,
      playback_cleared: result.snapshot.playbackCleared,
      caller_response_pending: result.snapshot.callerResponsePending,
      reducer_effects: result.effects.map((effect) => effect.type),
      executable_effects: result.executable.map((effect) => effect.type),
      observed_only_effects: result.observedOnly.map((effect) => effect.type),
      emission_mode: "active",
      owner: "response_coordinator",
    });
    this.executePostSemanticEffectsV40([...result.executable]);
    return [...result.executable];
  }

  private reportStaleDoneV40(id: string): void {
    const activeId = responseCoordinatorFor(this).snapshot().activeResponseId;
    if (!activeId || activeId === id) return;
    (this as any).diagnostics?.checkpoint?.("STALE_RESPONSE_DONE_IGNORED_V40_REBUILD", {
      stale_response_id: id, active_response_id: activeId, active_response_preserved: true,
    });
  }

  private setNormalListeningV40(responseIdValue: string): void {
    if (this.listeningResponseIdV40 === responseIdValue) return;
    const session = this as any;
    if (!session.socket || conversationLifecyclePortFor(this).isTerminal()) return;
    realtimeCommandPortFor(session).beginNonInterruptingListening(inputDetectionConfigRuntimeFor(this).get());
    this.listeningResponseIdV40 = responseIdValue;
    session.diagnostics?.checkpoint?.("BARGE_IN_LISTENING_ACTIVE_V40_REBUILD", {
      response_id: responseIdValue,
      automatic_interrupt: false,
      automatic_response: false,
      owner_state: responseCoordinatorFor(this).snapshot().state,
      playback_window_active: this.playbackBargeInWindowV40,
      provider_command_port: true,
    });
  }

  private invalidateNormalListeningV40(reason: string, responseIdValue: string | null): void {
    const previousResponseId = this.listeningResponseIdV40;
    this.listeningResponseIdV40 = null;
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_LISTENING_INVALIDATED_V40_REBUILD", {
      reason, response_id: responseIdValue, previous_listening_response_id: previousResponseId,
      vad_restored: false, next_playback_must_reassert: true,
    });
  }

  private restoreNormalVadV40(reason: string): void {
    if (!this.listeningResponseIdV40) return;
    const session = this as any;
    this.listeningResponseIdV40 = null;
    if (!session.socket || conversationLifecyclePortFor(this).isTerminal()) return;
    realtimeCommandPortFor(session).restoreInputDetection(inputDetectionConfigRuntimeFor(this).get());
    session.diagnostics?.checkpoint?.("BARGE_IN_LISTENING_RELEASED_V40_REBUILD", { reason, provider_command_port: true });
  }

  private recoverIgnoredProviderClearedPlaybackV40(source: string, itemId: string | null): void {
    const session = this as any;
    const route = decideIgnoredBargeInPlaybackRecovery({
      providerClearedPlaybackBeforeDecision: this.providerClearedPlaybackBeforeDecisionV40,
      terminal: conversationLifecyclePortFor(this).isTerminal() || responseCoordinatorFor(this).snapshot().state === "TERMINAL",
    });
    this.providerClearedPlaybackBeforeDecisionV40 = false;
    if (route !== "RECOVER_LIVENESS" || !session.socket) return;
    realtimeCommandPortFor(session).speak({
      tools: "DISABLED", isolated: true, purpose: "provider_clear_liveness_recovery_v40",
      instructions: `Pronuncia exactamente esta frase y nada más: ${JSON.stringify(PROVIDER_CLEAR_LIVENESS_MESSAGE)}`,
      exactText: PROVIDER_CLEAR_LIVENESS_MESSAGE,
    });
    session.diagnostics?.checkpoint?.("BARGE_IN_PROVIDER_CLEAR_LIVENESS_RECOVERY_V40_REBUILD", {
      source, item_id: itemId, recovery_route: route, isolated_response: true,
      tools_disabled: true, business_action_executed: false, synthetic_continuation: false, timer_used: false,
    });
  }

  private executeIgnoredCallerDispositionV40(itemId: string): void {
    executeCallerTurnDisposition(
      this as any,
      { itemId, disposition: "IGNORE" },
      () => { try { realtimeCommandPortFor(this as any).discardInputItem(itemId); } catch {} },
    );
  }

  private executeNormalCallerDispositionV40(event: Extract<RealtimeProviderEvent, { type: "CALLER_TRANSCRIPT_COMPLETED" }>): void {
    const itemId = typeof event.itemId === "string" ? event.itemId : "";
    if (!itemId || !usableTranscript(event.transcript)) return;
    if (responseCoordinatorFor(this).snapshot().state === "BARGE_IN_CLASSIFYING") return;
    executeCallerTurnDisposition(this as any, { itemId, disposition: "NORMAL" }, () => {});
  }

  private requestClassifierV40(event: Extract<RealtimeProviderEvent, { type: "CALLER_TRANSCRIPT_COMPLETED" }>, data: unknown): boolean {
    const owner = responseCoordinatorFor(this).snapshot();
    if (owner.state !== "BARGE_IN_CLASSIFYING") return false;
    const itemId = typeof event.itemId === "string" ? event.itemId : "";
    const transcript = usableTranscript(event.transcript);
    if (!itemId || !transcript) return false;
    const latestStarted = bargeInOrderingRuntimeFor(this).latestStarted();
    if (this.pendingBargeInV40) {
      const isNewestStartedItem = itemId !== this.pendingBargeInV40.itemId && itemId === latestStarted;
      if (isNewestStartedItem) {
        (this as any).diagnostics?.checkpoint?.("BARGE_IN_NEWER_FRAGMENT_TRANSCRIPT_FORWARDED_V40_REBUILD", {
          classifier_source_item_id: this.pendingBargeInV40.itemId, newer_item_id: itemId,
          semantic_pipeline_allowed: true, classifier_still_pending: true, input_item_deleted: false, timer_used: false,
        });
        return false;
      }
      this.executeIgnoredCallerDispositionV40(itemId);
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_EXTRA_CANDIDATE_DROPPED_V40_REBUILD", {
        item_id: itemId, pending_item_id: this.pendingBargeInV40.itemId,
      });
      return true;
    }
    const pending: PendingBargeIn = { itemId, transcript, originalData: data };
    this.pendingBargeInV40 = pending;
    semanticDecisionPortFor(this as any).request(buildBargeInClassifierRequest(transcript, itemId));
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_CLASSIFIER_REQUESTED_V40_REBUILD", {
      item_id: itemId, transcript_length: transcript.length,
      active_response_id: owner.activeResponseId, playback_cleared: owner.playbackCleared, semantic_decision_port: true,
    });
    return true;
  }

  private executePreSemanticEffectsV40(effects: ResponseOwnerEffect[]): void {
    const realtime = realtimeCommandPortFor(this as any);
    for (const effect of effects) {
      if (effect.type === "cancel_response") realtime.cancelResponse(effect.responseId);
      else if (effect.type === "clear_playback") { this.clientClearRequestedV40 = true; realtime.clearPlayback(); }
    }
  }

  private executePostSemanticEffectsV40(effects: ResponseOwnerEffect[]): void {
    const realtime = realtimeCommandPortFor(this as any);
    for (const effect of effects) {
      if (effect.type === "create_caller_response") realtime.createDefaultResponse();
    }
  }

  private cancelledResponseIdV40(effects: readonly ResponseOwnerEffect[]): string | null {
    const cancelled = effects.find((effect): effect is Extract<ResponseOwnerEffect, { type: "cancel_response" }> => effect.type === "cancel_response");
    return cancelled?.responseId ?? null;
  }

  private reportConfirmedBargeInV40(options: {
    classifierSourceItemId: string; semanticItemId: string; effects: ResponseOwnerEffect[];
    turnOwnershipBypassed: boolean; deferredToNewerSpeech: boolean; fallbackFromUnusableNewer?: boolean;
  }): void {
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_CONFIRMED_V40_REBUILD", {
      item_id: options.classifierSourceItemId,
      semantic_item_id: options.semanticItemId,
      classifier_source_item_id: options.classifierSourceItemId,
      cancelled_response_id: this.cancelledResponseIdV40(options.effects),
      playback_was_already_cleared: responseCoordinatorFor(this).snapshot().playbackCleared,
      promoted_to_v39_semantic_pipeline: true,
      v36_turn_lock_bypassed: options.turnOwnershipBypassed,
      turn_ownership_runtime: true,
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
    const ownership = turnOwnershipRuntimeFor(this);
    ownership.claimSemanticItem(pending.itemId);
    try { await BasePrototype.handleRealtimeMessage.call(this, pending.originalData); }
    finally { ownership.releaseSemanticItem(pending.itemId); }
    this.executePostSemanticEffectsV40(effects);
    const classifierSourceItemId = options.classifierSourceItemId ?? pending.itemId;
    this.reportConfirmedBargeInV40({
      classifierSourceItemId, semanticItemId: pending.itemId, effects,
      turnOwnershipBypassed: true,
      deferredToNewerSpeech: classifierSourceItemId !== pending.itemId,
      fallbackFromUnusableNewer: options.fallbackFromUnusableNewer,
    });
  }

  private async handleDeferredConfirmedTranscriptV40(
    event: Extract<RealtimeProviderEvent, { type: "CALLER_TRANSCRIPT_COMPLETED" }>, data: unknown,
  ): Promise<boolean> {
    const deferred = this.deferredConfirmedBargeInV40;
    if (!deferred) return false;
    const ordering = bargeInOrderingRuntimeFor(this);
    const latestStarted = ordering.latestStarted();
    if (latestStarted && deferred.targetItemId !== latestStarted) deferred.targetItemId = latestStarted;
    const itemId = typeof event.itemId === "string" ? event.itemId : null;
    const transcript = usableTranscript(event.transcript);
    const route = decideDeferredBargeInTranscriptRoute(deferred.targetItemId, itemId, Boolean(transcript));
    if (route === "WAIT_FOR_LATEST") {
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_DEFERRED_INTERMEDIATE_TRANSCRIPT_SUPPRESSED_V40_REBUILD", {
        classifier_source_item_id: deferred.source.itemId, target_item_id: deferred.targetItemId,
        completed_item_id: itemId, semantic_pipeline_entered: false, input_item_deleted: false, timer_used: false,
      });
      return true;
    }
    this.deferredConfirmedBargeInV40 = null;
    if (route === "FALLBACK_SOURCE") {
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_DEFERRED_LATEST_UNUSABLE_FALLBACK_V40_REBUILD", {
        classifier_source_item_id: deferred.source.itemId, target_item_id: deferred.targetItemId,
        completed_item_id: itemId, fallback_item_id: deferred.source.itemId, timer_used: false,
      });
      await this.promoteConfirmedSourceV40(deferred.source, deferred.postSemanticEffects, {
        classifierSourceItemId: deferred.source.itemId, fallbackFromUnusableNewer: true,
      });
      return true;
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
    this.executePostSemanticEffectsV40(deferred.postSemanticEffects);
    this.reportConfirmedBargeInV40({
      classifierSourceItemId: deferred.source.itemId, semanticItemId: itemId as string,
      effects: deferred.postSemanticEffects, turnOwnershipBypassed: false, deferredToNewerSpeech: true,
    });
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_DEFERRED_LATEST_FRAGMENT_PROMOTED_V40_REBUILD", {
      classifier_source_item_id: deferred.source.itemId, item_id: itemId, target_item_id: deferred.targetItemId,
      semantic_pipeline_entered: true, v36_turn_lock_bypassed: false,
      response_creation_released_after_latest_transcript: true, timer_used: false,
    });
    return true;
  }

  private resolveUnclassifiableCandidateV40(event: Extract<RealtimeProviderEvent, { type: "CALLER_TRANSCRIPT_COMPLETED" }>): boolean {
    const coordinator = responseCoordinatorFor(this);
    if (coordinator.snapshot().state !== "BARGE_IN_CLASSIFYING") return false;
    const itemId = typeof event.itemId === "string" ? event.itemId : "";
    const transcript = usableTranscript(event.transcript);
    if (itemId && transcript) return false;
    const result = coordinator.applyBargeInDecision("IGNORE");
    if (!result.accepted) return false;
    this.reportOwnerEffectsV40(result.effects);
    if (itemId) this.executeIgnoredCallerDispositionV40(itemId);
    this.executePostSemanticEffectsV40([...result.executable]);
    this.recoverIgnoredProviderClearedPlaybackV40("unclassifiable_candidate", itemId || null);
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_UNCLASSIFIABLE_IGNORED_V40_REBUILD", {
      item_id_present: Boolean(itemId), usable_transcript_present: Boolean(transcript),
      playback_cleared: result.snapshot.playbackCleared, semantic_pipeline_entered: false,
      resolved_without_watchdog: true, provider_neutral_event: true,
    });
    return true;
  }

  private async finalizeClassifierV40(responseIdValue: string, text: unknown): Promise<void> {
    const pending = this.classifierByResponseV40.get(responseIdValue);
    if (!pending) return;
    this.classifierByResponseV40.delete(responseIdValue);
    if (this.pendingBargeInV40?.itemId === pending.itemId) this.pendingBargeInV40 = null;
    const decision = parseBargeInDecision(text);
    const result = responseCoordinatorFor(this).applyBargeInDecision(decision);
    if (!result.accepted) {
      (this as any).diagnostics?.fail?.("BARGE_IN_DECISION_REJECTED_V40_REBUILD", "OWNER_NOT_CLASSIFYING", {
        item_id: pending.itemId, decision, owner_state: responseCoordinatorFor(this).snapshot().state,
      });
      return;
    }
    this.reportOwnerEffectsV40(result.effects);
    if (decision === "IGNORE") {
      this.executeIgnoredCallerDispositionV40(pending.itemId);
      this.executePostSemanticEffectsV40([...result.executable]);
      this.recoverIgnoredProviderClearedPlaybackV40("classified_ignore", pending.itemId);
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_IGNORED_V40_REBUILD", {
        item_id: pending.itemId, playback_cleared: result.snapshot.playbackCleared,
        active_response_id: result.snapshot.activeResponseId,
        semantic_pipeline_entered: false,
      });
      return;
    }

    this.providerClearedPlaybackBeforeDecisionV40 = false;
    const dispositionExecutor = executeCallerTurnDisposition(
      this as any,
      { itemId: pending.itemId, disposition: "INTERRUPT" },
      () => this.executePreSemanticEffectsV40([...result.executable]),
    );
    const postSemanticEffects = dispositionExecutor === "CAPABILITY"
      ? result.executable.filter((effect) => effect.type !== "create_caller_response")
      : [...result.executable];
    const ordering = bargeInOrderingRuntimeFor(this);
    const latestStarted = ordering.latestStarted();
    const latestCompleted = ordering.latestCompleted();
    const promotionRoute = decideConfirmedBargeInPromotion(pending.itemId, latestStarted);
    if (promotionRoute === "DEFER_TO_NEWER_SPEECH" && latestStarted) {
      const targetItemId = latestStarted;
      (this as any).diagnostics?.checkpoint?.("BARGE_IN_CONFIRMED_DEFERRED_TO_NEWER_SPEECH_V40_REBUILD", {
        classifier_source_item_id: pending.itemId, target_item_id: targetItemId,
        target_transcript_already_completed: latestCompleted === targetItemId,
        cancelled_response_id: this.cancelledResponseIdV40(result.effects),
        response_creation_deferred: latestCompleted !== targetItemId, timer_used: false,
        caller_disposition_executor: dispositionExecutor,
      });
      if (latestCompleted === targetItemId) {
        this.executePostSemanticEffectsV40(postSemanticEffects);
        this.reportConfirmedBargeInV40({
          classifierSourceItemId: pending.itemId, semanticItemId: targetItemId,
          effects: postSemanticEffects, turnOwnershipBypassed: false, deferredToNewerSpeech: true,
        });
        (this as any).diagnostics?.checkpoint?.("BARGE_IN_NEWER_COMPLETED_FRAGMENT_RESPONSE_RELEASED_V40_REBUILD", {
          classifier_source_item_id: pending.itemId, item_id: targetItemId,
          semantic_pipeline_already_entered: true, response_creation_released: dispositionExecutor === "LEGACY",
          caller_disposition_executor: dispositionExecutor,
          v36_turn_lock_bypassed: false, timer_used: false,
        });
        return;
      }
      this.deferredConfirmedBargeInV40 = { source: pending, targetItemId, postSemanticEffects };
      return;
    }
    await this.promoteConfirmedSourceV40(pending, postSemanticEffects);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const providerEvents = adaptRealtimeProviderEvents(data);
    for (const event of providerEvents) {
      const id = providerResponseId(event);
      const isClassifierResponse = event.type === "ASSISTANT_RESPONSE_STARTED" && event.purpose === BARGE_IN_METADATA_PURPOSE;
      if (isClassifierResponse) {
        const sourceItemId = event.sourceItemId ?? "";
        const pending = this.pendingBargeInV40;
        if (id && pending && pending.itemId === sourceItemId) {
          this.classifierByResponseV40.set(id, pending);
          (this as any).diagnostics?.checkpoint?.("BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD", {
            response_id: id, item_id: sourceItemId, provider_neutral_event: event.type,
          });
        }
        return;
      }
      if (event.type === "TEXT_DECISION_COMPLETED" && id && this.classifierByResponseV40.has(id)) {
        await this.finalizeClassifierV40(id, event.text); return;
      }
      if (event.type === "ASSISTANT_RESPONSE_COMPLETED" && id && this.classifierByResponseV40.has(id)) {
        await this.finalizeClassifierV40(id, "IGNORE"); return;
      }
      if (event.type === "CALLER_TRANSCRIPT_COMPLETED") {
        const completedItemId = typeof event.itemId === "string" ? event.itemId : null;
        bargeInOrderingRuntimeFor(this).observeTranscriptCompleted(completedItemId);
        if (await this.handleDeferredConfirmedTranscriptV40(event, data)) return;
        if (this.resolveUnclassifiableCandidateV40(event)) return;
        if (this.requestClassifierV40(event, data)) return;
        this.executeNormalCallerDispositionV40(event);
      }
      if (event.type === "ASSISTANT_RESPONSE_STARTED" && id) {
        if (event.kind !== "NORMAL") this.protectedResponseIdsV40.add(id);
        this.reconcileOwnerEventV40({ type: "assistant_response_started", responseId: id });
      } else if (event.type === "ASSISTANT_RESPONSE_COMPLETED" && id) {
        this.reportStaleDoneV40(id);
        this.reconcileOwnerEventV40({ type: "assistant_response_done", responseId: id });
        this.protectedResponseIdsV40.delete(id);
      } else if (event.type === "ASSISTANT_AUDIO_CLEARED") {
        const ownerState = responseCoordinatorFor(this).snapshot().state;
        const providerClearedBeforeDecision = ownerState === "BARGE_IN_CLASSIFYING" && !this.clientClearRequestedV40;
        if (providerClearedBeforeDecision) {
          this.providerClearedPlaybackBeforeDecisionV40 = true;
          (this as any).diagnostics?.checkpoint?.("BARGE_IN_PROVIDER_CLEAR_BEFORE_DECISION_V40_REBUILD", {
            response_id: id, owner_state: ownerState, client_clear_requested: false,
            semantic_decision_pending: true, provider_playback_loss_irreversible: true,
          });
        }
        this.clientClearRequestedV40 = false;
        this.reconcileOwnerEventV40({ type: "assistant_playback_cleared" });
        if (id) this.protectedResponseIdsV40.delete(id);
        this.playbackBargeInWindowV40 = false;
        this.invalidateNormalListeningV40("assistant_playback_cleared", id);
      } else if (event.type === "CALLER_SPEECH_STARTED") {
        this.observeCallerSpeechStartedV40(event.itemId ?? null);
        if (this.playbackBargeInWindowV40) this.reconcileOwnerEventV40({ type: "caller_speech_started" });
      }

      const normalPlaybackStarting = event.type === "ASSISTANT_AUDIO_STARTED"
        && Boolean(id)
        && !this.protectedResponseIdsV40.has(id as string)
        && responseCoordinatorFor(this).snapshot().state === "ASSISTANT_ACTIVE";
      if (normalPlaybackStarting) {
        this.playbackBargeInWindowV40 = true;
        bargeInOrderingRuntimeFor(this).reset();
        this.providerClearedPlaybackBeforeDecisionV40 = false;
        this.clientClearRequestedV40 = false;
        (this as any).diagnostics?.checkpoint?.("BARGE_IN_PLAYBACK_WINDOW_OPENED_V40_REBUILD", {
          response_id: id, authority_from: "assistant_playback_started",
          opened_before_lower_layers: true, provider_neutral_event: event.type,
        });
      } else if (event.type === "ASSISTANT_AUDIO_STOPPED") {
        this.playbackBargeInWindowV40 = false;
        this.providerClearedPlaybackBeforeDecisionV40 = false;
        this.clientClearRequestedV40 = false;
      }

      if (conversationLifecyclePortFor(this).isTerminal()) {
        this.reconcileOwnerEventV40({ type: "terminal" });
        this.pendingBargeInV40 = null;
        this.classifierByResponseV40.clear();
        this.protectedResponseIdsV40.clear();
        this.listeningResponseIdV40 = null;
        this.playbackBargeInWindowV40 = false;
        turnOwnershipRuntimeFor(this).releaseSemanticItem();
        bargeInOrderingRuntimeFor(this).reset();
        this.deferredConfirmedBargeInV40 = null;
        this.providerClearedPlaybackBeforeDecisionV40 = false;
        this.clientClearRequestedV40 = false;
      }

      await BasePrototype.handleRealtimeMessage.call(this, data);
      if (normalPlaybackStarting && id) this.setNormalListeningV40(id);
      else if (event.type === "ASSISTANT_AUDIO_STOPPED") {
        if (id) this.protectedResponseIdsV40.delete(id);
        this.restoreNormalVadV40("assistant_playback_stopped");
      }
      return;
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
