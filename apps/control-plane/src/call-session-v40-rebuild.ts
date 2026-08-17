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
  BARGE_IN_METADATA_PURPOSE,
  buildBargeInClassifierRequest,
  parseBargeInDecision,
} from "./barge-in-confirmation";
import { realtimeCommandPortFor } from "./openai-realtime-command-adapter";

const BaseConstructor = CallSessionV39 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV39.prototype as any;
const RESPONSE_OWNER_EMISSION_MODE: ResponseOwnerEmissionMode = "active";
const PROTECTED_METADATA_KEY = "protected_speech_v35";
const HANDOFF_METADATA_KEY = "human_handoff_v37";

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
  originalData: unknown;
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

function usableTranscript(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
}

function isProtectedMetadata(metadata: Record<string, unknown>): boolean {
  return Boolean(metadata[PROTECTED_METADATA_KEY] || metadata[HANDOFF_METADATA_KEY]);
}

/**
 * Rebuild v40: single authority for classified normal-speech barge-in above the
 * known-good v39 baseline.
 *
 * Invariants:
 * - raw VAD never authorizes cancellation or a new semantic response;
 * - protected greeting/recovery/handoff speech is never made interruptible here;
 * - normal assistant response ownership opens the semantic barge-in window at
 *   response.created; provider listening confirmation is an effect, not authority;
 * - completed caller speech is classified out-of-conversation as INTERRUPT/IGNORE;
 * - an unclassifiable candidate resolves immediately as IGNORE;
 * - confirmed barge-in has one lifecycle owner: v40. v36 explicitly yields that
 *   item instead of acquiring a second concurrency lock;
 * - response.done is reconciliation evidence only and never gates continuation.
 */
export class CallSession extends BaseConstructor {
  private responseOwnerV40: ResponseOwnerSnapshot = initialResponseOwnerSnapshot();
  private pendingBargeInV40: PendingBargeIn | null = null;
  private classifierByResponseV40 = new Map<string, PendingBargeIn>();
  private protectedResponseIdsV40 = new Set<string>();
  private normalListeningV40 = false;
  private semanticBargeInWindowV40 = false;
  private v40OwnedSemanticItemId: string | null = null;

  protected shouldBypassTurnConcurrencyV36(event: RealtimeEvent): boolean {
    return Boolean(this.v40OwnedSemanticItemId && event.item_id === this.v40OwnedSemanticItemId);
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
      reducer_effects: result.effects.map((effect) => effect.type),
      executable_effects: emission.executable.map((effect) => effect.type),
      observed_only_effects: emission.observedOnly.map((effect) => effect.type),
      emission_mode: RESPONSE_OWNER_EMISSION_MODE,
    });
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

  private setNormalListeningV40(): void {
    if (this.normalListeningV40) return;
    const session = this as any;
    if (!session.socket || session.state === "closing" || session.hangupStarted) return;
    realtimeCommandPortFor(session).beginNonInterruptingListening(session.tenantVadV35 ?? {});
    this.normalListeningV40 = true;
    session.diagnostics?.checkpoint?.("BARGE_IN_LISTENING_ACTIVE_V40_REBUILD", {
      automatic_interrupt: false,
      automatic_response: false,
      owner_state: this.responseOwnerV40.state,
      semantic_window_active: this.semanticBargeInWindowV40,
    });
  }

  private restoreNormalVadV40(reason: string): void {
    if (!this.normalListeningV40) return;
    const session = this as any;
    this.normalListeningV40 = false;
    if (!session.socket || session.state === "closing" || session.hangupStarted) return;
    realtimeCommandPortFor(session).restoreInputDetection(session.tenantVadV35 ?? {});
    session.diagnostics?.checkpoint?.("BARGE_IN_LISTENING_RELEASED_V40_REBUILD", { reason });
  }

  private requestClassifierV40(event: RealtimeEvent, data: unknown): boolean {
    if (this.responseOwnerV40.state !== "BARGE_IN_CLASSIFYING") return false;
    const itemId = typeof event.item_id === "string" ? event.item_id : "";
    const transcript = usableTranscript(event.transcript);
    if (!itemId || !transcript) return false;

    if (this.pendingBargeInV40) {
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

  private resolveUnclassifiableCandidateV40(event: RealtimeEvent): boolean {
    if (this.responseOwnerV40.state !== "BARGE_IN_CLASSIFYING") return false;
    const itemId = typeof event.item_id === "string" ? event.item_id : "";
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
        semantic_pipeline_entered: false,
      });
      return;
    }

    this.executePreSemanticEffectsV40(emission.executable);
    this.v40OwnedSemanticItemId = pending.itemId;
    try {
      await BasePrototype.handleRealtimeMessage.call(this, pending.originalData);
    } finally {
      this.v40OwnedSemanticItemId = null;
    }
    this.executePostSemanticEffectsV40(emission.executable);
    const cancelled = result.effects.find((effect): effect is Extract<ResponseOwnerEffect, { type: "cancel_response" }> => effect.type === "cancel_response");
    (this as any).diagnostics?.checkpoint?.("BARGE_IN_CONFIRMED_V40_REBUILD", {
      item_id: pending.itemId,
      cancelled_response_id: cancelled?.responseId ?? null,
      playback_was_already_cleared: result.snapshot.playbackCleared,
      promoted_to_v39_semantic_pipeline: true,
      v36_turn_lock_bypassed: true,
      response_done_gate: false,
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);
    const metadata = event?.response?.metadata ?? {};
    const id = event ? responseId(event) : null;
    const isClassifierResponse = metadata.purpose === BARGE_IN_METADATA_PURPOSE;

    if (event?.type === "response.created" && isClassifierResponse) {
      const sourceItemId = typeof metadata.source_item_id === "string" ? metadata.source_item_id : "";
      const pending = this.pendingBargeInV40;
      if (id && pending && pending.itemId === sourceItemId) {
        this.classifierByResponseV40.set(id, pending);
        (this as any).diagnostics?.checkpoint?.("BARGE_IN_CLASSIFIER_BOUND_V40_REBUILD", {
          response_id: id,
          item_id: sourceItemId,
        });
      }
      return;
    }

    if (event?.type === "response.output_text.done" && id && this.classifierByResponseV40.has(id)) {
      await this.finalizeClassifierV40(id, event.text);
      return;
    }

    if (event?.type === "response.done" && id && this.classifierByResponseV40.has(id)) {
      await this.finalizeClassifierV40(id, "IGNORE");
      return;
    }

    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      if (this.resolveUnclassifiableCandidateV40(event)) return;
      if (this.requestClassifierV40(event, data)) return;
    }

    if (event?.type === "response.created" && id) {
      const protectedResponse = isProtectedMetadata(metadata);
      if (protectedResponse) {
        this.protectedResponseIdsV40.add(id);
      }
      this.reconcileOwnerEventV40({ type: "assistant_response_started", responseId: id });
      if (!protectedResponse) {
        this.semanticBargeInWindowV40 = true;
        (this as any).diagnostics?.checkpoint?.("BARGE_IN_SEMANTIC_WINDOW_OPENED_V40_REBUILD", {
          response_id: id,
          authority_from: "assistant_response_started",
          playback_start_required: false,
        });
        this.setNormalListeningV40();
      }
    } else if (event?.type === "response.done" && id) {
      this.reportStaleDoneV40(id);
      this.reconcileOwnerEventV40({ type: "assistant_response_done", responseId: id });
      this.protectedResponseIdsV40.delete(id);
    } else if (event?.type === "output_audio_buffer.cleared") {
      this.reconcileOwnerEventV40({ type: "assistant_playback_cleared" });
      if (id) this.protectedResponseIdsV40.delete(id);
    } else if (event?.type === "input_audio_buffer.speech_started") {
      if (this.semanticBargeInWindowV40 && this.responseOwnerV40.state === "ASSISTANT_ACTIVE") {
        const providerListeningConfirmed = this.normalListeningV40;
        this.reconcileOwnerEventV40({ type: "caller_speech_started" });
        if (!providerListeningConfirmed) {
          (this as any).diagnostics?.checkpoint?.("BARGE_IN_EARLY_OWNERSHIP_CLAIMED_V40_REBUILD", {
            owner_state: this.responseOwnerV40.state,
            provider_listening_confirmed: false,
            semantic_window_active: true,
          });
        }
      }
    }

    if ((this as any).state === "closing" || (this as any).hangupStarted) {
      this.reconcileOwnerEventV40({ type: "terminal" });
      this.pendingBargeInV40 = null;
      this.classifierByResponseV40.clear();
      this.protectedResponseIdsV40.clear();
      this.normalListeningV40 = false;
      this.semanticBargeInWindowV40 = false;
      this.v40OwnedSemanticItemId = null;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);

    if (event?.type === "output_audio_buffer.started" && id && !this.protectedResponseIdsV40.has(id) && this.responseOwnerV40.state === "ASSISTANT_ACTIVE") {
      this.setNormalListeningV40();
    } else if (event?.type === "output_audio_buffer.stopped") {
      if (id) this.protectedResponseIdsV40.delete(id);
      this.semanticBargeInWindowV40 = false;
      this.restoreNormalVadV40("assistant_playback_stopped");
    }
  }
}
