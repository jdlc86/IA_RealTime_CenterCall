import { CallSession as CallSessionV43 } from "./call-session-v43-handoff-authorization";
import { decideRawVadRoute } from "./raw-vad-barge-in-routing";

const BaseConstructor = CallSessionV43 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV43.prototype as any;
const PROTECTED_METADATA_KEY = "protected_speech_v35";
const HANDOFF_METADATA_KEY = "human_handoff_v37";

type RealtimeEvent = {
  type?: string;
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

function isProtectedMetadata(metadata: Record<string, unknown>): boolean {
  return Boolean(metadata[PROTECTED_METADATA_KEY] || metadata[HANDOFF_METADATA_KEY]);
}

/**
 * v44 closes the raw-VAD authority leak discovered in live menu playback.
 *
 * v40 already models raw speech_started as classification evidence only, but it
 * historically forwarded the same event into inherited pre-v40 handlers. Those
 * handlers may clear playback immediately, so an acoustic false positive can
 * silence Lucia before the v40 INTERRUPT/IGNORE decision exists.
 *
 * During normal assistant playback this layer therefore routes speech_started
 * directly to v40's response-owner transition and consumes the raw event. The
 * completed transcript still follows the normal chain, allowing v40 to classify
 * it and only a confirmed INTERRUPT to enter the inherited semantic pipeline.
 */
export class CallSession extends BaseConstructor {
  private protectedResponseIdsV44 = new Set<string>();
  private normalPlaybackActiveV44 = false;

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);
    const id = event ? responseId(event) : null;

    if (event?.type === "response.created" && id) {
      const metadata = event.response?.metadata ?? {};
      if (isProtectedMetadata(metadata)) this.protectedResponseIdsV44.add(id);
    }

    if (event?.type === "output_audio_buffer.started" && id) {
      this.normalPlaybackActiveV44 = !this.protectedResponseIdsV44.has(id);
    } else if (event?.type === "output_audio_buffer.stopped" || event?.type === "output_audio_buffer.cleared") {
      this.normalPlaybackActiveV44 = false;
      if (id) this.protectedResponseIdsV44.delete(id);
    }

    if (decideRawVadRoute(event?.type, this.normalPlaybackActiveV44) === "V40_ONLY") {
      const reconcile = (this as any).reconcileOwnerEventV40;
      if (typeof reconcile === "function") {
        reconcile.call(this, { type: "caller_speech_started" });
        (this as any).diagnostics?.checkpoint?.("RAW_VAD_ROUTED_TO_V40_ONLY_V44", {
          response_id: id,
          normal_playback_active: true,
          inherited_raw_vad_suppressed: true,
          semantic_authority: "v40_classifier",
        });
        return;
      }

      (this as any).diagnostics?.fail?.(
        "RAW_VAD_V40_AUTHORITY_UNAVAILABLE_V44",
        "V40_RECONCILER_MISSING",
        { inherited_raw_vad_suppressed: false },
      );
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
