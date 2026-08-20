import { CallSession as CallSessionV43 } from "./call-session-v43-handoff-authorization";
import { decideRawVadRoute } from "./raw-vad-barge-in-routing";
import { adaptRealtimeProviderEvents } from "./realtime-provider-runtime.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import { beginSemanticTurnFromAcousticEvidence } from "./semantic-turn-coordinator.js";
import { responseCoordinatorFor } from "./response-coordinator.js";
import { bargeInOrderingRuntimeFor } from "./barge-in-ordering-runtime.js";

const BaseConstructor = CallSessionV43 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV43.prototype as any;

function responseId(event: RealtimeProviderEvent): string | null {
  return "responseId" in event && typeof event.responseId === "string" ? event.responseId : null;
}

/** Raw VAD compatibility adapter; all cross-layer authority is composed. */
export class CallSession extends BaseConstructor {
  private protectedResponseIdsV44 = new Set<string>();
  private normalPlaybackActiveV44 = false;

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const providerEvents = adaptRealtimeProviderEvents(data);
    for (const event of providerEvents) {
      const id = responseId(event);
      if (event.type === "ASSISTANT_RESPONSE_STARTED" && id && event.kind !== "NORMAL") this.protectedResponseIdsV44.add(id);
      if (event.type === "ASSISTANT_AUDIO_STARTED" && id) {
        this.normalPlaybackActiveV44 = !this.protectedResponseIdsV44.has(id);
      } else if (event.type === "ASSISTANT_AUDIO_STOPPED" || event.type === "ASSISTANT_AUDIO_CLEARED") {
        this.normalPlaybackActiveV44 = false;
        if (id) this.protectedResponseIdsV44.delete(id);
      }

      if (event.type === "CALLER_SPEECH_STARTED") {
        bargeInOrderingRuntimeFor(this).observeSpeechStarted(event.itemId ?? null);
      }

      if (decideRawVadRoute(event.type, this.normalPlaybackActiveV44) === "V40_ONLY") {
        if (event.type === "CALLER_SPEECH_STARTED") {
          beginSemanticTurnFromAcousticEvidence(this, { itemId: event.itemId ?? null, source: "v44_raw_vad_route" });
        }
        const reconciliation = responseCoordinatorFor(this).reconcile({ type: "caller_speech_started" });
        (this as any).diagnostics?.checkpoint?.("RAW_VAD_ROUTED_TO_V40_ONLY_V44", {
          response_id: id,
          item_id: event.type === "CALLER_SPEECH_STARTED" ? event.itemId ?? null : null,
          normal_playback_active: true,
          inherited_raw_vad_suppressed: true,
          semantic_authority: "response_coordinator",
          semantic_turn_bookkeeping_reset: true,
          provider_neutral_event: event.type,
          response_owner_state: reconciliation.snapshot.state,
        });
        return;
      }
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
