import { CallSession as CallSessionV40 } from "./call-session-v40-rebuild";
import { realtimeCommandPortFor } from "./openai-realtime-command-adapter";
import {
  decideEndCallProposal,
  hasExplicitUserFarewellEvidence,
  isExplicitClosingConfirmation,
  shouldCommitPendingClose,
} from "./core-closing-policy.js";

const BaseConstructor = CallSessionV40 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV40.prototype as any;
const END_CALL = "restaurant_end_call";
const CLOSE_CONFIRMATION_PROMPT = "¿Quieres que finalice la llamada?";

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  transcript?: unknown;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function parseEvent(data: unknown): RealtimeEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as RealtimeEvent; } catch { return null; }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function usableTranscript(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
}

/**
 * v41 protects the irreversible end-call boundary.
 *
 * The model may propose restaurant_end_call, but it cannot authorize itself.
 * A blocked end-call proposal creates one pending close. The confirmation
 * question is emitted through the provider command port with tools disabled,
 * so no model-selected public tool can steal that recovery response. If the
 * caller then explicitly confirms, v41 commits the already-pending backend
 * action directly. Repeated model proposals while confirmation is pending are
 * acknowledged without creating another response.
 */
export class CallSession extends BaseConstructor {
  private closingConfirmationPendingV41 = false;
  private userClosingEvidenceV41 = false;
  private lastUserTranscriptV41 = "";

  private commitConfirmedPendingCloseV41(transcript: string): boolean {
    if (!shouldCommitPendingClose(this.closingConfirmationPendingV41, transcript)) return false;

    this.lastUserTranscriptV41 = transcript;
    this.userClosingEvidenceV41 = false;
    this.closingConfirmationPendingV41 = false;

    const session = this as any;
    session.diagnostics?.checkpoint?.("USER_CLOSING_EVIDENCE_EVALUATED_V41", {
      direct_farewell: false,
      confirmed_pending_close: true,
      closing_authorized: true,
    });
    session.diagnostics?.checkpoint?.("END_CALL_AUTHORIZED_BY_USER_EVIDENCE_V41", {
      model_confirmed: true,
      caller_evidence_present: true,
      authority_source: "pending_close_plus_explicit_confirmation",
      model_retry_required: false,
    });
    session.beginClosing?.("agent_end_confirmed_v41", "caller_confirmed_pending_close_v41");
    return true;
  }

  private recordUserTranscriptV41(transcript: string): void {
    this.lastUserTranscriptV41 = transcript;
    const directFarewell = hasExplicitUserFarewellEvidence(transcript);
    const confirmsPending = this.closingConfirmationPendingV41 && isExplicitClosingConfirmation(transcript);
    this.userClosingEvidenceV41 = directFarewell || confirmsPending;
    if (this.closingConfirmationPendingV41) this.closingConfirmationPendingV41 = false;

    (this as any).diagnostics?.checkpoint?.("USER_CLOSING_EVIDENCE_EVALUATED_V41", {
      direct_farewell: directFarewell,
      confirmed_pending_close: confirmsPending,
      closing_authorized: this.userClosingEvidenceV41,
    });
  }

  private rejectUngroundedEndCallV41(callId: string | undefined): void {
    this.closingConfirmationPendingV41 = true;
    this.userClosingEvidenceV41 = false;
    const session = this as any;
    session.send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({
          ok: true,
          status: "USER_CONFIRMATION_REQUIRED",
          instruction: "No finalices la llamada todavía. La capa de cierre formulará directamente la pregunta de confirmación y esperará la respuesta explícita del usuario.",
        }),
      },
    });

    realtimeCommandPortFor(session).speak({
      instructions: `Pronuncia exactamente esta pregunta y nada más: ${JSON.stringify(CLOSE_CONFIRMATION_PROMPT)}`,
      exactText: CLOSE_CONFIRMATION_PROMPT,
      tools: "DISABLED",
      isolated: true,
      purpose: "close_confirmation_v41",
      metadata: {
        authority: "closure_guard_v41",
        pending_close: true,
      },
    });

    session.diagnostics?.checkpoint?.("CLOSE_CONFIRMATION_PROMPT_EMITTED_V41", {
      prompt: CLOSE_CONFIRMATION_PROMPT,
      tool_choice: "none",
      isolated_response: true,
      pending_close: true,
      response_authority: "closure_guard_v41",
    });
    session.diagnostics?.checkpoint?.("END_CALL_BLOCKED_WITHOUT_USER_EVIDENCE_V41", {
      model_confirmed_argument_ignored: true,
      last_user_transcript_present: Boolean(this.lastUserTranscriptV41),
      irreversible_close_prevented: true,
      pending_close_recorded: true,
      confirmation_prompt_owned_by_backend: true,
    });
  }

  private acknowledgePendingEndCallV41(callId: string | undefined): void {
    const session = this as any;
    session.send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({
          ok: true,
          status: "USER_CONFIRMATION_PENDING",
          instruction: "La confirmación de cierre ya está pendiente. No vuelvas a solicitar restaurant_end_call y espera un nuevo turno del usuario.",
        }),
      },
    });
    session.diagnostics?.checkpoint?.("END_CALL_DUPLICATE_SUPPRESSED_WHILE_CONFIRMATION_PENDING_V41", {
      irreversible_close_prevented: true,
      confirmation_still_pending: true,
      response_create_emitted: false,
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);

    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = usableTranscript(event.transcript);
      if (transcript) {
        if (this.commitConfirmedPendingCloseV41(transcript)) return;
        this.recordUserTranscriptV41(transcript);
      }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === END_CALL) {
      const session = this as any;
      if (session.state === "closing" || session.hangupStarted) return;

      const args = parseArgs(event.arguments);
      const decision = decideEndCallProposal(
        this.closingConfirmationPendingV41,
        this.userClosingEvidenceV41,
        args.confirmed === true,
      );

      if (decision.action === "ACK_PENDING") {
        this.acknowledgePendingEndCallV41(event.call_id);
        return;
      }

      if (decision.action === "ASK_CONFIRMATION") {
        this.rejectUngroundedEndCallV41(event.call_id);
        return;
      }

      session.diagnostics?.checkpoint?.("END_CALL_AUTHORIZED_BY_USER_EVIDENCE_V41", {
        model_confirmed: true,
        caller_evidence_present: true,
        authority_source: "direct_user_evidence_before_tool",
        model_retry_required: false,
      });
      this.userClosingEvidenceV41 = false;
      this.closingConfirmationPendingV41 = false;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
