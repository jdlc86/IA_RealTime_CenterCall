import { CallSession as CallSessionV42 } from "./call-session-v42-turn-boundaries";
import {
  authorizeHumanHandoff,
  initialHumanHandoffAuthorizationState,
  type HumanHandoffAuthorizationState,
} from "./human-handoff-authorization-policy.js";

const BaseConstructor = CallSessionV42 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV42.prototype as any;
const HUMAN_ASSISTANCE = "restaurant_human_assistance";

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  transcript?: unknown;
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

function usableTranscript(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 1500) : null;
}

/**
 * v43 separates semantic recommendation from irreversible handoff authority.
 *
 * Lucia may decide that human assistance would be useful, but the runtime only
 * permits the terminal v37 transport when the current caller turn explicitly
 * requests a human or explicitly accepts a transfer that was previously
 * offered. Model-only reasons such as SYSTEM_LIMITATION are not authority.
 */
export class CallSession extends BaseConstructor {
  private handoffAuthorizationV43: HumanHandoffAuthorizationState = initialHumanHandoffAuthorizationState();
  private latestCallerTranscriptV43: string | null = null;

  private rejectUnauthorizedHandoffV43(event: RealtimeEvent, source: "OFFER_REQUIRED" | "CALLER_REJECTED"): void {
    const session = this as any;
    session.releaseSemanticGateV29?.(HUMAN_ASSISTANCE);
    session.send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify({
          ok: true,
          status: source === "CALLER_REJECTED" ? "HUMAN_HANDOFF_DECLINED" : "HUMAN_HANDOFF_CONFIRMATION_REQUIRED",
          transfer_started: false,
          instruction: source === "CALLER_REJECTED"
            ? "No transfieras. El usuario no ha autorizado la transferencia. Continúa solo con las gestiones que puedas resolver."
            : "No transfieras todavía. Explica brevemente que esta gestión puede requerir una persona y pregunta si desea que le transfieras. Espera una respuesta explícita del usuario.",
        }),
      },
    });
    session.send?.({ type: "response.create" });
    session.diagnostics?.checkpoint?.("HUMAN_HANDOFF_BLOCKED_WITHOUT_CALLER_AUTHORITY_V43", {
      authorization_source: source,
      transfer_started: false,
      caller_transcript_present: Boolean(this.latestCallerTranscriptV43),
      offer_pending: this.handoffAuthorizationV43.offerPending,
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);

    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = usableTranscript(event.transcript);
      if (transcript) this.latestCallerTranscriptV43 = transcript;
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === HUMAN_ASSISTANCE) {
      const decision = authorizeHumanHandoff(this.handoffAuthorizationV43, this.latestCallerTranscriptV43);
      this.handoffAuthorizationV43 = decision.state;

      if (!decision.allowed) {
        this.rejectUnauthorizedHandoffV43(event, decision.source);
        return;
      }

      (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_AUTHORIZED_BY_CALLER_V43", {
        authorization_source: decision.source,
        caller_transcript_present: Boolean(this.latestCallerTranscriptV43),
      });
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
