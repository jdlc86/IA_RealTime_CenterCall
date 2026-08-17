import { CallSession as CallSessionV39 } from "./call-session-v39";
import {
  initialResponseOwnerSnapshot,
  reduceResponseOwner,
  type ResponseOwnerEvent,
  type ResponseOwnerSnapshot,
} from "./realtime-response-owner";

const BaseConstructor = CallSessionV39 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV39.prototype as any;

type RealtimeEvent = {
  type?: string;
  response_id?: string;
  response?: { id?: string };
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
 * Rebuild v40: passive response-ownership observer above the known-good v39.
 *
 * This class intentionally does NOT emit response.create, response.cancel, or
 * playback commands. Its only job is to prove that one state model can
 * reconcile the Realtime/SIP events seen by v39 without changing behaviour.
 * Authority will be enabled only after synthetic and CI coverage proves the
 * event mapping is sound.
 */
export class CallSession extends BaseConstructor {
  private responseOwnerV40: ResponseOwnerSnapshot = initialResponseOwnerSnapshot();

  private applyOwnerEventV40(event: ResponseOwnerEvent): void {
    const previous = this.responseOwnerV40;
    const result = reduceResponseOwner(previous, event);
    this.responseOwnerV40 = result.snapshot;

    (this as any).diagnostics?.checkpoint?.("RESPONSE_OWNER_OBSERVED_V40_REBUILD", {
      event_type: event.type,
      previous_state: previous.state,
      next_state: result.snapshot.state,
      active_response_id: result.snapshot.activeResponseId,
      playback_cleared: result.snapshot.playbackCleared,
      caller_response_pending: result.snapshot.callerResponsePending,
      emitted_effects: result.effects.map((effect) => effect.type),
      effects_executed: false,
      passive_observer: true,
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);

    if (event?.type === "response.created") {
      const id = responseId(event);
      if (id) this.applyOwnerEventV40({ type: "assistant_response_started", responseId: id });
    } else if (event?.type === "response.done") {
      const id = responseId(event);
      if (id) this.applyOwnerEventV40({ type: "assistant_response_done", responseId: id });
    } else if (event?.type === "output_audio_buffer.cleared") {
      this.applyOwnerEventV40({ type: "assistant_playback_cleared" });
    } else if (event?.type === "input_audio_buffer.speech_started") {
      this.applyOwnerEventV40({ type: "caller_speech_started" });
    }

    if ((this as any).state === "closing" || (this as any).hangupStarted) {
      this.applyOwnerEventV40({ type: "terminal" });
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
