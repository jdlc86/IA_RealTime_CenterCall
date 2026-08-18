import { CallSession as CallSessionV40 } from "./call-session-v40-rebuild";
import {
  adaptRealtimeProviderEvents,
  installRealtimeSessionPolicyTransform,
  realtimeCommandPortFor,
} from "./realtime-provider-runtime.js";
import {
  assessControllerCloseIntent,
  decideCloseConsensus,
  isAssistantMoreHelpQuestion,
  isExplicitClosingConfirmation,
  isExplicitClosingRejection,
  resolveReplyToMoreHelpQuestion,
  type ControllerCloseAssessment,
} from "./core-closing-policy.js";

const BaseConstructor = CallSessionV40 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV40.prototype as any;
const END_CALL = "restaurant_end_call";
const CLOSE_CONFIRMATION_PROMPT = "¿Quieres terminar la llamada?";
const COURTESY_FOLLOWUP_INSTRUCTION = "Responde de forma breve y natural preguntando si puedes ayudar al usuario en algo más. No menciones terminar, colgar ni cerrar la llamada.";
const CLOSING_GUIDANCE_START = "[[V41_CLOSING_GUIDANCE_START]]";
const CLOSING_GUIDANCE_END = "[[V41_CLOSING_GUIDANCE_END]]";
const CLOSING_GUIDANCE = `${CLOSING_GUIDANCE_START}\nPROTOCOLO NATURAL DE CIERRE:\n- La cortesía y la intención de cierre son dimensiones distintas. Un simple agradecimiento NO implica cierre: pregunta de forma natural si puedes ayudar en algo más.\n- Si acabas de preguntar si el usuario necesita algo más y responde negativamente (por ejemplo 'no, gracias' o 'nada más'), ese contexto YA resuelve el cierre: despídete de forma natural y termina la llamada; no vuelvas a preguntar si quiere terminar.\n- Una frase puede contener cortesía y cierre a la vez. Por ejemplo 'muchas gracias, no necesito nada más' o 'gracias, hasta luego' expresa cierre claro: puedes proponer restaurant_end_call.\n- Para un cierre espontáneo, si tú y el controlador detectáis CLOSE hay consenso fuerte y se cierra. Solo si tú propones cierre y el controlador no lo confirma se pedirá '¿Quieres terminar la llamada?'; esa ruta debe ser excepcional.\n- Si el usuario corrige el cierre con una nueva petición ('hasta luego... espera, una cosa más'), prevalece la nueva petición.\n- Nunca uses restaurant_input_ignored para resolver una intención de cierre.\n${CLOSING_GUIDANCE_END}`;

type PendingCloseResolutionV41 = "CLOSE" | "CONTINUE" | "RELEASE";

function usableTranscript(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
}

function readEndCallConfirmedV41(argumentsText: string | undefined): boolean | null {
  if (typeof argumentsText !== "string" || !argumentsText.trim()) return null;
  try {
    const parsed = JSON.parse(argumentsText) as { confirmed?: unknown };
    return typeof parsed.confirmed === "boolean" ? parsed.confirmed : null;
  } catch {
    return null;
  }
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
 * v41 has two closing paths:
 * 1. context-resolved closing: Lucia explicitly asked whether more help is
 *    needed and the caller answers negatively. No arbitration is needed.
 * 2. spontaneous closing: Lucia and the independent controller seek consensus;
 *    only disagreement/insufficient evidence asks explicit confirmation.
 */
export class CallSession extends BaseConstructor {
  private closingConfirmationPendingV41 = false;
  private moreHelpAnswerPendingV41 = false;
  private moreHelpSemanticResolutionPendingV41 = false;
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

    // Provider-neutral authority for all migrated session policy updates.
    installRealtimeSessionPolicyTransform(session, (update) => {
      if (typeof update.instructions !== "string") return update;
      return { ...update, instructions: withClosingGuidance(update.instructions) };
    });

    // Compatibility fallback for historical layers that still emit raw OpenAI
    // session.update messages. withClosingGuidance is idempotent, so migrated
    // updates may safely pass through both boundaries with no behavior change.
    this.originalSendV41 = currentSend.bind(this);
    session.send = (message: any) => {
      if (message?.type === "session.update" && typeof message?.session?.instructions === "string") {
        this.originalSendV41?.({
          ...message,
          session: { ...message.session, instructions: withClosingGuidance(message.session.instructions) },
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

  private commitCloseThroughLifecycleV41(reason: string, source: string): void {
    const session = this as any;
    if (typeof session.observeEndCallConfirmedV18 === "function") {
      session.diagnostics?.checkpoint?.("V41_CLOSE_COMMITTED_TO_LIFECYCLE", {
        reason,
        source,
        authority: "ConversationTurnLifecycle",
      });
      session.observeEndCallConfirmedV18(reason);
      return;
    }
    session.diagnostics?.checkpoint?.("V41_CLOSE_LIFECYCLE_COMPATIBILITY_FALLBACK", {
      reason,
      source,
      authority: "legacy_beginClosing",
    });
    session.beginClosing?.(reason, source);
  }

  private markMoreHelpQuestionV41(source: string, transcript?: string): void {
    if (this.moreHelpAnswerPendingV41 || this.moreHelpSemanticResolutionPendingV41) {
      (this as any).diagnostics?.checkpoint?.("MORE_HELP_QUESTION_DUPLICATE_OBSERVED_V41", {
        source,
        assistant_transcript_present: Boolean(transcript),
        state_reopened: false,
        contextual_authority_unchanged: true,
      });
      return;
    }

    this.moreHelpAnswerPendingV41 = true;
    this.moreHelpSemanticResolutionPendingV41 = false;
    (this as any).diagnostics?.checkpoint?.("MORE_HELP_QUESTION_OPENED_V41", {
      source,
      assistant_transcript_present: Boolean(transcript),
      next_negative_reply_resolves_close: true,
      arbitration_required: false,
    });
  }

  private resolveMoreHelpAnswerV41(transcript: string): boolean {
    if (!this.moreHelpAnswerPendingV41) return false;
    const resolution = resolveReplyToMoreHelpQuestion(transcript);
    const session = this as any;

    if (resolution === "CLOSE") {
      this.moreHelpAnswerPendingV41 = false;
      this.moreHelpSemanticResolutionPendingV41 = false;
      this.closingConfirmationPendingV41 = false;
      this.controllerCloseAssessmentV41 = { courtesy: /gracias/i.test(transcript), closeIntent: "CLOSE" };
      session.diagnostics?.checkpoint?.("CONTEXTUAL_CLOSE_RESOLVED_V41", {
        context: "ANSWER_TO_MORE_HELP_QUESTION",
        caller_resolution: "NO_MORE_HELP",
        arbitration_required: false,
        explicit_close_confirmation_required: false,
      });
      this.commitCloseThroughLifecycleV41("contextual_close_resolved_v41", "caller_declined_more_help_v41");
      return true;
    }

    if (resolution === "CONTINUE") {
      this.moreHelpAnswerPendingV41 = false;
      this.moreHelpSemanticResolutionPendingV41 = false;
      session.diagnostics?.checkpoint?.("MORE_HELP_QUESTION_RESOLVED_V41", {
        caller_resolution: resolution,
        close_committed: false,
        context_preserved: false,
      });
      return false;
    }

    // An ASR transcript can be usable but still too weak for the deterministic
    // resolver even when the model correctly understands the same caller turn.
    // Do not downgrade that turn to a spontaneous close. Preserve contextual
    // authority only until the model's semantic decision for this response is
    // known, then release it so it can never leak into a later caller turn.
    this.moreHelpAnswerPendingV41 = false;
    this.moreHelpSemanticResolutionPendingV41 = true;
    session.diagnostics?.checkpoint?.("MORE_HELP_QUESTION_RESOLVED_V41", {
      caller_resolution: resolution,
      close_committed: false,
      context_preserved: true,
      awaiting_semantic_resolution: true,
    });
    session.diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_AWAITING_SEMANTIC_RESOLUTION_V41", {
      contextual_authority: "MORE_HELP_REPLY",
      transcript_resolution: "UNRESOLVED",
      context_preserved: true,
      confirmation_question_emitted: false,
    });
    return false;
  }

  private submitEndCallToolResultV41(callId: string | undefined, output: Record<string, unknown>): void {
    realtimeCommandPortFor(this as any).submitToolResult({
      callId,
      toolName: END_CALL,
      output,
    });
  }

  private emitCourtesyFollowupV41(callId: string | undefined): void {
    const session = this as any;
    this.submitEndCallToolResultV41(callId, {
      ok: true,
      status: "COURTESY_FOLLOWUP_REQUIRED",
      instruction: "El usuario fue cortés pero no expresó intención de cierre. Pregunta si puedes ayudarle en algo más y continúa la conversación.",
    });
    realtimeCommandPortFor(session).speak({
      instructions: COURTESY_FOLLOWUP_INSTRUCTION,
      tools: "DISABLED",
      isolated: true,
      purpose: "courtesy_followup_v41",
      metadata: { authority: "closing_consensus_v41", courtesy: true, close_intent: "ABSTAIN" },
    });
    this.markMoreHelpQuestionV41("COURTESY_FOLLOWUP_V41");
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
    this.moreHelpAnswerPendingV41 = false;
    this.moreHelpSemanticResolutionPendingV41 = false;
    this.closingConfirmationPendingV41 = true;
    const session = this as any;
    this.submitEndCallToolResultV41(callId, {
      ok: true,
      status: "CLOSE_INTENT_AMBIGUOUS",
      instruction: "Lucía detectó cierre pero el controlador no confirmó una intención clara. La capa v41 preguntará al usuario si quiere terminar y esperará su respuesta.",
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
    this.submitEndCallToolResultV41(callId, {
      ok: true,
      status: "CLOSE_INTENT_CONFIRMATION_PENDING",
      instruction: "La pregunta de cierre ya está pendiente. Espera la respuesta del usuario.",
    });
    session.diagnostics?.checkpoint?.("CLOSE_INTENT_DUPLICATE_SUPPRESSED_V41", {
      confirmation_still_pending: true,
      response_create_emitted: false,
    });
  }

  private acknowledgeContextualReplyPendingV41(callId: string | undefined): void {
    const session = this as any;
    this.submitEndCallToolResultV41(callId, {
      ok: true,
      status: "CONTEXTUAL_CLOSE_REPLY_PENDING",
      instruction: "La respuesta del usuario a tu pregunta de continuidad es la autoridad de este turno. No generes otra pregunta de cierre.",
    });
    session.diagnostics?.checkpoint?.("PREMATURE_END_CALL_SUPERSEDED_BY_MORE_HELP_CONTEXT_V41", {
      contextual_authority: "MORE_HELP_REPLY",
      arbitration_started: false,
      extra_audio_emitted: false,
      artificial_wait_ms: 0,
    });
  }

  private resolveContextualSemanticEndCallV41(callId: string | undefined, modelConfirmed: boolean | null): boolean {
    if (!this.moreHelpSemanticResolutionPendingV41) return false;

    this.moreHelpSemanticResolutionPendingV41 = false;
    const session = this as any;
    if (modelConfirmed !== true) {
      session.diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_SEMANTIC_CONTEXT_RELEASED_V41", {
        reason: "END_CALL_NOT_CONFIRMED",
        model_confirmed: modelConfirmed,
        contextual_close_committed: false,
      });
      return false;
    }

    this.moreHelpAnswerPendingV41 = false;
    this.closingConfirmationPendingV41 = false;
    this.controllerCloseAssessmentV41 = { courtesy: false, closeIntent: "CLOSE" };
    this.submitEndCallToolResultV41(callId, {
      ok: true,
      status: "CONTEXTUAL_CLOSE_RESOLVED",
      speak: false,
      mutation: false,
    });
    session.diagnostics?.checkpoint?.("CONTEXTUAL_CLOSE_RESOLVED_V41", {
      context: "ANSWER_TO_MORE_HELP_QUESTION",
      caller_resolution: "NO_MORE_HELP",
      resolution_source: "LUCIA_CONFIRMED_END_CALL_AFTER_UNRESOLVED_CONTEXTUAL_TRANSCRIPT",
      arbitration_required: false,
      explicit_close_confirmation_required: false,
    });
    this.commitCloseThroughLifecycleV41("contextual_close_semantic_resolution_v41", "lucia_confirmed_contextual_end_call_v41");
    return true;
  }

  private resolvePendingCloseFromCallerV41(transcript: string): PendingCloseResolutionV41 {
    if (!this.closingConfirmationPendingV41) return "RELEASE";
    const session = this as any;

    if (isExplicitClosingConfirmation(transcript)) {
      this.closingConfirmationPendingV41 = false;
      this.controllerCloseAssessmentV41 = { courtesy: false, closeIntent: "CLOSE" };
      session.diagnostics?.checkpoint?.("CLOSE_AMBIGUITY_RESOLVED_BY_CALLER_V41", {
        caller_resolution: "CLOSE",
        consensus: true,
        turn_consumed: true,
      });
      this.commitCloseThroughLifecycleV41("agent_end_confirmed_v41", "caller_resolved_close_ambiguity_v41");
      return "CLOSE";
    }

    if (isExplicitClosingRejection(transcript)) {
      this.closingConfirmationPendingV41 = false;
      this.controllerCloseAssessmentV41 = { courtesy: false, closeIntent: "CONTINUE" };
      session.diagnostics?.checkpoint?.("CLOSE_AMBIGUITY_RESOLVED_BY_CALLER_V41", {
        caller_resolution: "CONTINUE",
        consensus: true,
        turn_consumed: true,
      });
      return "CONTINUE";
    }

    this.closingConfirmationPendingV41 = false;
    this.controllerCloseAssessmentV41 = assessControllerCloseIntent(transcript);
    session.diagnostics?.checkpoint?.("CLOSE_AMBIGUITY_RELEASED_TO_NORMAL_TURN_V41", {
      controller_close_intent: this.controllerCloseAssessmentV41.closeIntent,
      courtesy: this.controllerCloseAssessmentV41.courtesy,
    });
    return "RELEASE";
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
    const providerEvents = adaptRealtimeProviderEvents(data);

    for (const event of providerEvents) {
      if (event.type === "ASSISTANT_TRANSCRIPT_COMPLETED") {
        const assistantTranscript = usableTranscript(event.transcript);
        if (assistantTranscript && isAssistantMoreHelpQuestion(assistantTranscript)) {
          this.markMoreHelpQuestionV41("LUCIA_ASSISTANT_TRANSCRIPT", assistantTranscript);
        }
      }

      if (event.type === "CALLER_TRANSCRIPT_COMPLETED") {
        const transcript = usableTranscript(event.transcript);
        if (transcript) {
          if (this.moreHelpAnswerPendingV41) {
            const closed = this.resolveMoreHelpAnswerV41(transcript);
            if (closed) return;
          }
          let closeTurnConsumed = false;
          if (this.closingConfirmationPendingV41) {
            const resolution = this.resolvePendingCloseFromCallerV41(transcript);
            if (resolution === "CLOSE") return;
            closeTurnConsumed = resolution === "CONTINUE";
          }
          if (!closeTurnConsumed) this.recordUserTranscriptV41(transcript);
          else (this as any).diagnostics?.checkpoint?.("CLOSE_RESOLUTION_TURN_CONSUMED_V41", {
            resolution: "CONTINUE",
            controller_reassessment_skipped: true,
            lower_semantic_pipeline_preserved: true,
          });
        }
      }

      if (
        event.type === "SEMANTIC_TOOL_SELECTED"
        && this.moreHelpSemanticResolutionPendingV41
        && event.name !== END_CALL
        && event.name !== "restaurant_input_ignored"
      ) {
        this.moreHelpSemanticResolutionPendingV41 = false;
        (this as any).diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_SEMANTIC_CONTEXT_RELEASED_V41", {
          reason: "SUBSTANTIVE_TOOL_SELECTED",
          tool: event.name,
          contextual_close_committed: false,
          lower_semantic_pipeline_preserved: true,
        });
      }

      if (event.type === "SEMANTIC_TOOL_SELECTED" && event.name === END_CALL) {
        const session = this as any;
        if (session.state === "closing" || session.hangupStarted) return;

        const modelConfirmed = readEndCallConfirmedV41(event.arguments);
        if (this.moreHelpSemanticResolutionPendingV41) {
          const contextualClosed = this.resolveContextualSemanticEndCallV41(event.callId, modelConfirmed);
          if (contextualClosed) return;
        }

        if (this.moreHelpAnswerPendingV41) {
          this.acknowledgeContextualReplyPendingV41(event.callId);
          return;
        }

        const decision = decideCloseConsensus(
          this.closingConfirmationPendingV41,
          this.controllerCloseAssessmentV41,
          true,
        );

        if (decision.action === "ACK_PENDING") {
          this.acknowledgePendingEndCallV41(event.callId);
          return;
        }
        if (decision.action === "COURTESY_FOLLOWUP") {
          this.emitCourtesyFollowupV41(event.callId);
          return;
        }
        if (decision.action === "AMBIGUOUS_CONFIRM") {
          this.emitAmbiguousConfirmationV41(event.callId);
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
        this.moreHelpAnswerPendingV41 = false;
        this.moreHelpSemanticResolutionPendingV41 = false;
        this.controllerCloseAssessmentV41 = { courtesy: false, closeIntent: "ABSTAIN" };
      }

      if (event.type === "ASSISTANT_RESPONSE_COMPLETED" && this.moreHelpSemanticResolutionPendingV41) {
        this.moreHelpSemanticResolutionPendingV41 = false;
        (this as any).diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_SEMANTIC_CONTEXT_RELEASED_V41", {
          reason: "ASSISTANT_RESPONSE_COMPLETED_WITHOUT_CONTEXTUAL_CLOSE",
          contextual_close_committed: false,
          context_leaked_to_next_turn: false,
        });
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
