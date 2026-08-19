import { CallSession as CallSessionV43 } from "./call-session-v43-handoff-authorization";
import { decideRawVadRoute } from "./raw-vad-barge-in-routing";
import { adaptRealtimeProviderEvents } from "./realtime-provider-runtime.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";

const BaseConstructor = CallSessionV43 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV43.prototype as any;

function responseId(event: RealtimeProviderEvent): string | null {
  return "responseId" in event && typeof event.responseId === "string" ? event.responseId : null;
}

/**
 * v44 closes the raw-VAD authority leak discovered in live menu playback.
 *
 * Provider wire events are translated before this layer sees them. During normal
 * assistant playback, CALLER_SPEECH_STARTED is acoustic evidence only and is routed
 * directly to v40's response-owner transition. The completed transcript still
 * follows the inherited chain so v40 can classify INTERRUPT/IGNORE before any
 * semantic action is authorized.
 *
 * The provider-neutral speech item identity is still forwarded to v40's ordering
 * observer even when the raw VAD event itself is suppressed from lower layers.
 * V29 also receives only a bookkeeping reset for that acoustic item: no semantic
 * gate or caller-directed authority is acquired until a completed transcript.
 */
export class CallSession extends BaseConstructor {
  private protectedResponseIdsV44 = new Set<string>();
  private normalPlaybackActiveV44 = false;

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const providerEvents = adaptRealtimeProviderEvents(data);

    for (const event of providerEvents) {
      const id = responseId(event);

      if (event.type === "ASSISTANT_RESPONSE_STARTED" && id && event.kind !== "NORMAL") {
        this.protectedResponseIdsV44.add(id);
      }

      if (event.type === "ASSISTANT_AUDIO_STARTED" && id) {
        this.normalPlaybackActiveV44 = !this.protectedResponseIdsV44.has(id);
      } else if (event.type === "ASSISTANT_AUDIO_STOPPED" || event.type === "ASSISTANT_AUDIO_CLEARED") {
        this.normalPlaybackActiveV44 = false;
        if (id) this.protectedResponseIdsV44.delete(id);
      }

      if (event.type === "CALLER_SPEECH_STARTED") {
        const observeSpeechStart = (this as any).observeCallerSpeechStartedV40;
        if (typeof observeSpeechStart === "function") {
          observeSpeechStart.call(this, event.itemId ?? null, "v44_raw_vad_route");
        }
      }

      if (decideRawVadRoute(event.type, this.normalPlaybackActiveV44) === "V40_ONLY") {
        const beginSemanticBookkeeping = (this as any).beginSemanticTurnFromAcousticEvidenceV29;
        if (typeof beginSemanticBookkeeping === "function" && event.type === "CALLER_SPEECH_STARTED") {
          beginSemanticBookkeeping.call(this, event.itemId ?? null, "v44_v40_only_raw_vad");
        }

        const reconcile = (this as any).reconcileOwnerEventV40;
        if (typeof reconcile === "function") {
          reconcile.call(this, { type: "caller_speech_started" });
          (this as any).diagnostics?.checkpoint?.("RAW_VAD_ROUTED_TO_V40_ONLY_V44", {
            response_id: id,
            item_id: event.type === "CALLER_SPEECH_STARTED" ? event.itemId ?? null : null,
            normal_playback_active: true,
            inherited_raw_vad_suppressed: true,
            semantic_authority: "v40_classifier",
            semantic_turn_bookkeeping_reset: true,
            provider_neutral_event: event.type,
          });
          return;
        }

        (this as any).diagnostics?.fail?.(
          "RAW_VAD_V40_AUTHORITY_UNAVAILABLE_V44",
          "V40_RECONCILER_MISSING",
          { inherited_raw_vad_suppressed: false },
        );
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
