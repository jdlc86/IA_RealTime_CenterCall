import { CallSession as CallSessionV42 } from "./call-session-v42";
import { CallSession as CallSessionV37 } from "./call-session-v37";
import { isExplicitHumanHandoffRequest } from "./human-handoff-request-policy";
import { planConfirmedBargeInPromotion } from "./barge-in-promotion-policy";

const BaseConstructor = CallSessionV42 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV42.prototype as any;
const V37Prototype = CallSessionV37.prototype as any;
const HUMAN_ASSISTANCE = "restaurant_human_assistance";

type RealtimeEventV43 = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  item_id?: string;
  transcript?: unknown;
  response_id?: string;
  response?: { id?: string; status?: string };
};

type PendingBargeInV43 = { itemId: string; transcript: string };

type AwaitingCancelledResponseV43 = {
  responseId: string;
  itemId: string;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function parseRealtimeEvent(data: unknown): RealtimeEventV43 | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as RealtimeEventV43; } catch { return null; }
}

function responseId(event: RealtimeEventV43 | null): string | null {
  return event?.response_id ?? event?.response?.id ?? null;
}

function usableTranscript(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
}

/**
 * v43 adds two deterministic safety invariants observed missing in production:
 * 1) human handoff requires explicit evidence in the caller's latest transcript;
 * 2) confirmed barge-in serializes response.cancel -> response.done -> response.create.
 */
export class CallSession extends BaseConstructor {
  private lastCallerTranscriptV43 = "";
  private awaitingCancelledResponseV43: AwaitingCancelledResponseV43 | null = null;

  private async beginHumanHandoffV37(event: RealtimeEventV43): Promise<boolean> {
    const session = this as any;
    if (!isExplicitHumanHandoffRequest(this.lastCallerTranscriptV43)) {
      session.releaseSemanticGateV29?.(HUMAN_ASSISTANCE);
      session.validateUserTurnV18?.("agent_tool");
      session.send?.({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: event.call_id,
          output: JSON.stringify({
            ok: false,
            status: "HUMAN_HANDOFF_REJECTED",
            reason: "EXPLICIT_CALLER_REQUEST_REQUIRED",
            transfer_started: false,
          }),
        },
      });
      session.send?.({
        type: "response.create",
        response: {
          instructions:
            "Continúa atendiendo la petición actual del usuario. No transfieras la llamada ni menciones una transferencia, salvo que el usuario la solicite explícitamente.",
        },
      });
      session.diagnostics?.checkpoint?.("HUMAN_HANDOFF_BLOCKED_NO_EXPLICIT_REQUEST_V43", {
        transcript_present: this.lastCallerTranscriptV43.length > 0,
        transfer_started: false,
        backend_authority: true,
      });
      return true;
    }

    session.diagnostics?.checkpoint?.("HUMAN_HANDOFF_EXPLICIT_REQUEST_CONFIRMED_V43", {
      transcript_present: true,
      backend_authority: true,
    });
    return V37Prototype.beginHumanHandoffV37.call(this, event);
  }

  private promoteConfirmedBargeInV36(pending: PendingBargeInV43): void {
    const session = this as any;
    session.pendingBargeInByItemV36?.delete?.(pending.itemId);

    const activeResponseId = typeof session.normalPlaybackResponseIdV36 === "string"
      ? session.normalPlaybackResponseIdV36
      : null;
    const playbackWasCleared = session.normalPlaybackClearedAwaitingDecisionV36 === true;
    const plan = planConfirmedBargeInPromotion(activeResponseId, playbackWasCleared);

    session.normalPlaybackActiveV36 = false;
    session.normalPlaybackResponseIdV36 = null;
    session.normalPlaybackClearedAwaitingDecisionV36 = false;

    session.acquireTurnConcurrencyV36?.();
    session.armSemanticGateV29?.(pending.transcript);
    session.confirmBargeInV40?.();

    if (plan.cancelActiveResponse && activeResponseId) {
      this.awaitingCancelledResponseV43 = { responseId: activeResponseId, itemId: pending.itemId };
      session.send?.({ type: "response.cancel", response_id: activeResponseId });
      if (plan.clearAudioBuffer) session.send?.({ type: "output_audio_buffer.clear" });
      session.diagnostics?.checkpoint?.("BARGE_IN_WAITING_FOR_CANCELLED_RESPONSE_DONE_V43", {
        item_id: pending.itemId,
        cancelled_response_id: activeResponseId,
        playback_was_already_cleared: playbackWasCleared,
        response_create_deferred: true,
      });
    } else {
      session.send?.({ type: "response.create" });
      session.diagnostics?.checkpoint?.("BARGE_IN_PROMOTED_IMMEDIATELY_V43", {
        item_id: pending.itemId,
        active_response_present: false,
      });
    }
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseRealtimeEvent(data);

    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = usableTranscript(event.transcript);
      if (transcript) this.lastCallerTranscriptV43 = transcript;
    }

    const awaiting = this.awaitingCancelledResponseV43;
    const completesAwaitedResponse = event?.type === "response.done" && awaiting && responseId(event) === awaiting.responseId;

    await BasePrototype.handleRealtimeMessage.call(this, data);

    if (completesAwaitedResponse && awaiting && this.awaitingCancelledResponseV43?.responseId === awaiting.responseId) {
      this.awaitingCancelledResponseV43 = null;
      const session = this as any;
      if (session.socket && session.state !== "closing" && !session.hangupStarted) {
        session.send?.({ type: "response.create" });
        session.diagnostics?.checkpoint?.("BARGE_IN_RESPONSE_CREATED_AFTER_CANCEL_DONE_V43", {
          item_id: awaiting.itemId,
          cancelled_response_id: awaiting.responseId,
          serialized: true,
        });
      }
    }
  }
}
