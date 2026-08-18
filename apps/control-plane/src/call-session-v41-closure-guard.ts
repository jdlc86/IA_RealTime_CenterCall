import { CallSession as CallSessionV40 } from "./call-session-v40-rebuild";
import { realtimeCommandPortFor } from "./openai-realtime-command-adapter";
import {
  assessControllerCloseIntent,
  decideCloseConsensus,
  isExplicitClosingConfirmation,
  isExplicitClosingRejection,
  type ControllerCloseAssessment,
} from "./core-closing-policy.js";

const BaseConstructor = CallSessionV40 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV40.prototype as any;
const END_CALL = "restaurant_end_call";
const CLOSE_CONFIRMATION_PROMPT = "¿Quieres terminar la llamada?";
const COURTESY_FOLLOWUP_INSTRUCTION = "Responde de forma breve y natural preguntando si puedes ayudar al usuario en algo más. No menciones terminar, colgar ni cerrar la llamada.";
const CLOSING_GUIDANCE_START = "[[V41_CLOSING_GUIDANCE_START]]";
const CLOSING_GUIDANCE_END = "[[V41_CLOSING_GUIDANCE_END]]";
const CLOSING_GUIDANCE = `${CLOSING_GUIDANCE_START}\nPROTOCOLO NATURAL DE CIERRE:\n- La cortesía y la intención de cierre son dimensiones distintas. Un simple agradecimiento como 'gracias', 'muchas gracias' o 'gracias por la información' NO implica cierre. En ese caso pregunta de forma natural si puedes ayudar en algo más.\n- Una frase puede contener cortesía y cierre a la vez. Por ejemplo 'muchas gracias, no necesito nada más' o 'gracias, hasta luego' expresa cierre claro: puedes proponer restaurant_end_call.\n- Si el usuario expresa de forma clara que quiere terminar (despedida inequívoca, petición de colgar, no necesitar nada más o equivalente), puedes proponer restaurant_end_call.\n- Solo si tú propones cierre y el controlador no confirma una intención clara se pedirá confirmación explícita. Esa ruta debe ser excepcional.\n- Nunca uses restaurant_input_ignored para resolver una intención de cierre.\n${CLOSING_GUIDANCE_END}`;

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

function usableTranscript(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
}

function stripClosingGuidance(instructions: string): string {
  const start = instructions.indexOf(CLOSING_GUIDANCE_START);
  if (start < 0) return instructions.trim();
  const end = instructions.indexOf(CLOSING_GUIDANCE_END, start);
  if (end < 0) return instructions.slice(0, start).trim();
  return `${instructions.slice(0, start)}${instructions.slice(end + CLOSING_GUIDANCE_END.length)}`.trim();
}

function withClosingGuidance(instructions: string): string {
  const base = stripClosingGuidance(instructions);
  return `${base}\n\n${CLOSING_GUIDANCE}`.trim();
}

/**
 * v41 models closing as consensus between Lucia's semantic proposal and an
 * independent controller assessment. Courtesy is contextual only and never a
 * close verdict by itself. A pure courtesy redirects to a natural follow-up;
 * explicit close agreement closes; only real disagreement asks for confirmation.
 */
export class CallSession extends BaseConstructor {
  private closingConfirmationPendingV41 = false;
  private controllerCloseAssessmentV41: ControllerCloseAssessment = { courtesy: false, closeIntent: "ABSTAIN" };
  private lastUserTranscriptV41 = "";
  private closingSendBoundaryInstalledV41 = false;
  private originalSendV41: ((message: unknown) => void) | null = null;

  private installClosingGuidanceBoundaryV41(): void {
    if (this.closingSendBoundaryInstalledV41) return;
    const session = this as any;
    const currentSend = session.send;
    if (typeof currentSend !== "function") return;
    this.closingSendBoundaryInstalledV41 = true;
    this.originalSendV41 = currentSend.bind(this);
    session.send = (message: any) => {
      if (message?.type === "session.update" && typeof message?.session?.instructions === "string") {
        this.originalSendV41?.({
          ...message,
          session: {
            ...message.session,
            instructions: withClosingGuidance(message.session.instructions),
          },
        });
        return;
      }
      this.originalSendV41?.(message);
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/start") this.installClosingGuidanceBoundaryV41();
    return super.fetch(request);
  }

  private emitCourtesyFollowupV41(callId: string | undefined): void {
    const session = this as any;
    session.send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({
          ok: true,
          status: "COURTESY_FOLLOWUP_REQUIRED",
          instruction: "El usuario fue cortés pero no expresó intención de cierre. Pregunta si puedes ayudarle en algo más y continúa la conversación.",
        }),
      },
    });
    realtimeCommandPortFor(session).speak({
      instructions: COURTESY_FOLLOWUP_INSTRUCTION,
      tools: "DISABLED",
      isolated: true,
      purpose: "courtesy_followup_v41",
      metadata: {
        authority: "closing_consensus_v41",
        courtesy: true,
        close_intent: "ABSTAIN",
      },
    });
    session.diagnostics?.checkpoint?.("COURTESY_FOLLOWUP_REQUESTED_V41", {
      courtesy: true,
      controller_close_intent: "ABSTAIN",
      lucia_close_proposal_redirected: true,
      close_confirmation_asked: false,
      next_action: "ASK_IF_MORE_HELP_NEEDED",
      tools_disabled: true,
    });
    this.controllerCloseAssessmentV41 = { courtesy: false, closeIntent: "ABSTAIN" };
  }

  private emitAmbiguousConfirmationV41(callId: string | undefined): void {
    this.closingConfirmationPendingV41 = true;
    const session = this as any;
    session.send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({
          ok: true,
          status: "CLOSE_INTENT_AMBIGUOUS",
          instruction: "Lucía detectó cierre pero el controlador no confirmó una intención clara. La capa v41 preguntará al usuario si quiere terminar y esperará su respuesta.",
        }),
      },
    });
    realtimeCommandPortFor(session).speak({
      instructions: `Pronuncia exactamente esta pregunta y nada más: ${JSON.stringify(CLOSE_CONFIRMATION_PROMPT)}`,
      exactText: CLOSE_CONFIRMATION_PROMPT,
      tools: "DISABLED",
      isolated: true,
      purpose: "close_intent_ambiguity_v41",
      metadata: { authority: "closing_consensus_v41", pending_close: true },
    });
    session.diagnostics?.checkpoint?.("CLOSE_INTENT_AMBIGUOUS_V41", {
      lucia_signal: "CLOSE",
      controller_close_intent: this.controllerCloseAssessmentV41.closeIntent,
      courtesy: this.controllerCloseAssessmentV41.courtesy,
      next_action: "ASK_CALLER",
      confirmation_prompt: CLOSE_CONFIRMATION_PROMPT,
      tool_choice: "none",
      presence_must_not_resolve: true,
      restaurant_input_ignored_forbidden: true,
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
          status: "CLOSE_INTENT_CONFIRMATION_PENDING",
          instruction: "La pregunta de cierre ya está pendiente. Espera la respuesta del usuario.",
        }),
      },
    });
    session.diagnostics?.checkpoint?.("CLOSE_INTENT_DUPLICATE_SUPPRESSED_V41", {
      confirmation_still_pending: true,
      response_create_emitted: false,
    });
  }

  private resolvePendingCloseFromCallerV41(transcript: string): boolean {
    if (!this.closingConfirmationPendingV41) return false;
    const session = this as any;

    if (isExplicitClosingConfirmation(transcript)) {
      this.closingConfirmationPendingV41 = false;
      this.controllerCloseAssessmentV41 = { courtesy: false, closeIntent: "CLOSE" };
      session.diagnostics?.checkpoint?.("CLOSE_AMBIGUITY_RESOLVED_BY_CALLER_V41", {
        caller_resolution: "CLOSE",
        consensus: true,
      });
      session.beginClosing?.("agent_end_confirmed_v41", "caller_resolved_close_ambiguity_v41");
      return true;
    }

    if (isExplicitClosingRejection(transcript)) {
      this.closingConfirmationPendingV41 = false;
      this.controllerCloseAssessmentV41 = { courtesy: false, closeIntent: "CONTINUE" };
      session.diagnostics?.checkpoint?.("CLOSE_AMBIGUITY_RESOLVED_BY_CALLER_V41", {
        caller_resolution: "CONTINUE",
        consensus: true,
      });
      return false;
    }

    this.closingConfirmationPendingV41 = false;
    this.controllerCloseAssessmentV41 = assessControllerCloseIntent(transcript);
    session.diagnostics?.checkpoint?.("CLOSE_AMBIGUITY_RELEASED_TO_NORMAL_TURN_V41", {
      controller_close_intent: this.controllerCloseAssessmentV41.closeIntent,
      courtesy: this.controllerCloseAssessmentV41.courtesy,
    });
    return false;
  }

  private recordUserTranscriptV41(transcript: string): void {
    this.lastUserTranscriptV41 = transcript;
    this.controllerCloseAssessmentV41 = assessControllerCloseIntent(transcript);
    (this as any).diagnostics?.checkpoint?.("CONTROLLER_CLOSE_ASSESSMENT_V41", {
      close_intent: this.controllerCloseAssessmentV41.closeIntent,
      courtesy: this.controllerCloseAssessmentV41.courtesy,
      courtesy_is_independent_dimension: true,
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);

    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = usableTranscript(event.transcript);
      if (transcript) {
        if (this.closingConfirmationPendingV41) {
          const closed = this.resolvePendingCloseFromCallerV41(transcript);
          if (closed) return;
        }
        this.recordUserTranscriptV41(transcript);
      }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === END_CALL) {
      const session = this as any;
      if (session.state === "closing" || session.hangupStarted) return;

      const decision = decideCloseConsensus(
        this.closingConfirmationPendingV41,
        this.controllerCloseAssessmentV41,
        true,
      );

      if (decision.action === "ACK_PENDING") {
        this.acknowledgePendingEndCallV41(event.call_id);
        return;
      }

      if (decision.action === "COURTESY_FOLLOWUP") {
        this.emitCourtesyFollowupV41(event.call_id);
        return;
      }

      if (decision.action === "AMBIGUOUS_CONFIRM") {
        this.emitAmbiguousConfirmationV41(event.call_id);
        return;
      }

      session.diagnostics?.checkpoint?.("CLOSE_CONSENSUS_REACHED_V41", {
        lucia_signal: "CLOSE",
        controller_close_intent: this.controllerCloseAssessmentV41.closeIntent,
        courtesy: this.controllerCloseAssessmentV41.courtesy,
        consensus: true,
        strong_close_consensus: true,
        last_user_transcript_present: Boolean(this.lastUserTranscriptV41),
      });
      this.closingConfirmationPendingV41 = false;
      this.controllerCloseAssessmentV41 = { courtesy: false, closeIntent: "ABSTAIN" };
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
