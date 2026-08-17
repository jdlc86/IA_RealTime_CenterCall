import { CallSession as CallSessionV39 } from "./call-session-v39";
import {
  initialResponseOwnerSnapshot,
  reduceResponseOwner,
  type ResponseOwnerEffect,
  type ResponseOwnerEvent,
  type ResponseOwnerSnapshot,
} from "./realtime-response-owner";
import { decideResponseOwnerEmission, type ResponseOwnerEmissionMode } from "./response-owner-emission-policy";

const BaseConstructor = CallSessionV39 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV39.prototype as any;
const RESPONSE_OWNER_EMISSION_MODE: ResponseOwnerEmissionMode = "shadow";

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
 * Rebuild v40: reconciliation authority above the known-good v39.
 *
 * One explicit policy boundary now owns whether reducer effects are allowed to
 * reach Realtime. The boundary is intentionally fixed to shadow mode here:
 * reconciliation is live, but no response.create/cancel/playback command can be
 * emitted by the rebuild until a later reviewed activation changes this switch.
 */
export class CallSession extends BaseConstructor {
  private responseOwnerV40: ResponseOwnerSnapshot = initialResponseOwnerSnapshot();

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

  private applyOwnerEventV40(event: ResponseOwnerEvent): void {
    const previous = this.responseOwnerV40;
    const result = reduceResponseOwner(previous, event);
    this.responseOwnerV40 = result.snapshot;
    this.reportOwnerEffectsV40(result.effects);

    const emission = decideResponseOwnerEmission(result.effects, RESPONSE_OWNER_EMISSION_MODE);
    if (emission.executable.length !== 0) {
      // Fail closed: this branch is unreachable while the compile-time mode is
      // shadow. Keeping the assertion visible prevents accidental socket writes
      // from being added around the authority boundary.
      (this as any).diagnostics?.fail?.("RESPONSE_OWNER_SHADOW_INVARIANT_BROKEN_V40_REBUILD", "SHADOW_MODE_PRODUCED_EXECUTABLE_EFFECTS", {
        executable_effects: emission.executable.map((effect) => effect.type),
      });
    }

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

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);

    if (event?.type === "response.created") {
      const id = responseId(event);
      if (id) this.applyOwnerEventV40({ type: "assistant_response_started", responseId: id });
    } else if (event?.type === "response.done") {
      const id = responseId(event);
      if (id) {
        this.reportStaleDoneV40(id);
        this.applyOwnerEventV40({ type: "assistant_response_done", responseId: id });
      }
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
