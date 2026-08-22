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
} from "./core-closing-policy.js";
import { closingSessionRuntimeFor } from "./closing-session-runtime.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { callerTurnContextRuntimeFor } from "./caller-turn-context-runtime.js";

const BaseConstructor = CallSessionV40 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV40.prototype as any;
const END_CALL = "restaurant_end_call";
const CLOSE_CONFIRMATION_PROMPT = "¿Quieres terminar la llamada?";
const COURTESY_FOLLOWUP_INSTRUCTION = "Responde de forma breve y natural preguntando si puedes ayudar al usuario en algo más. No menciones terminar, colgar ni cerrar la llamada.";
const CLOSING_GUIDANCE_START = "[[V41_CLOSING_GUIDANCE_START]]";
const CLOSING_GUIDANCE_END = "[[V41_CLOSING_GUIDANCE_END]]";
const CLOSING_GUIDANCE = `${CLOSING_GUIDANCE_START}\nPROTOCOLO NATURAL DE CIERRE:\n- La cortesía y la intención de cierre son dimensiones distintas. Un simple agradecimiento NO implica cierre: pregunta de forma natural si puedes ayudar en algo más.\n- Si acabas de preguntar si el usuario necesita algo más y responde negativamente (por ejemplo 'no, gracias' o 'nada más'), ese contexto YA resuelve el cierre: despídete de forma natural y termina la llamada; no vuelvas a preguntar si quiere terminar.\n- Una frase puede contener cortesía y cierre a la vez. Por ejemplo 'muchas gracias, no necesito nada más' o 'gracias, hasta luego' expresa cierre claro: usa restaurant_end_call confirmed=true.\n- Para un cierre espontáneo inequívoco usa confirmed=true. Si el controlador también detecta CLOSE hay consenso fuerte; si se abstiene sin detectar cortesía aislada ni una petición de continuar, tu confirmación semántica basta. Una petición explícita de continuar siempre prevalece.\n- Usa confirmed=false solo si la intención de finalizar es realmente ambigua; en ese caso se preguntará una vez si quiere terminar.\n- Si el usuario corrige el cierre con una nueva petición ('hasta luego... espera, una cosa más'), prevalece la nueva petición.\n- Nunca uses restaurant_input_ignored para resolver una intención de cierre.\n${CLOSING_GUIDANCE_END}`;

function usableTranscript(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
}
function readEndCallConfirmedV41(argumentsText: string | undefined): boolean | null {
  if (typeof argumentsText !== "string" || !argumentsText.trim()) return null;
  try {
    const parsed = JSON.parse(argumentsText) as { confirmed?: unknown };
    return typeof parsed.confirmed === "boolean" ? parsed.confirmed : null;
  } catch { return null; }
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

/** Compatibility adapter. Shared close authority is owned by ClosingSessionRuntime. */
export class CallSession extends BaseConstructor {
  private moreHelpAnswerPendingV41 = false;
  private moreHelpSemanticResolutionPendingV41 = false;
  private lastUserTranscriptV41 = "";
  private closingGuidanceBoundaryInstalledV41 = false;

  private installClosingGuidanceBoundaryV41(): void {
    if (this.closingGuidanceBoundaryInstalledV41) return;
    this.closingGuidanceBoundaryInstalledV41 = true;
    installRealtimeSessionPolicyTransform(this as any, (update) => {
      if (typeof update.instructions !== "string") return update;
      return { ...update, instructions: withClosingGuidance(update.instructions) };
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/start") this.installClosingGuidanceBoundaryV41();
    return super.fetch(request);
  }

  private commitCloseV41(reason: string, source: string): void {
    (this as any).diagnostics?.checkpoint?.("V41_CLOSE_COMMITTED_TO_LIFECYCLE", {
      reason, source, authority: "conversation_lifecycle_port",
    });
    conversationLifecyclePortFor(this).confirmEndCall(reason, source);
  }

  private markMoreHelpQuestionV41(source: string, transcript?: string): void {
    if (this.moreHelpAnswerPendingV41 || this.moreHelpSemanticResolutionPendingV41) {
      (this as any).diagnostics?.checkpoint?.("MORE_HELP_QUESTION_DUPLICATE_OBSERVED_V41", {
        source, assistant_transcript_present: Boolean(transcript), state_reopened: false, contextual_authority_unchanged: true,
      });
      return;
    }
    this.moreHelpAnswerPendingV41 = true;
    this.moreHelpSemanticResolutionPendingV41 = false;
    (this as any).diagnostics?.checkpoint?.("MORE_HELP_QUESTION_OPENED_V41", {
      source, assistant_transcript_present: Boolean(transcript), next_negative_reply_resolves_close: true, arbitration_required: false,
    });
  }

  private resolveMoreHelpAnswerV41(): void {
    if (!this.moreHelpAnswerPendingV41) return;
    const session = this as any;
    this.moreHelpAnswerPendingV41 = false;
    this.moreHelpSemanticResolutionPendingV41 = true;
    session.diagnostics?.checkpoint?.("MORE_HELP_QUESTION_RESOLVED_V41", {
      caller_resolution: "MODEL_SEMANTIC_TOOL_PENDING", close_committed: false,
      context_preserved: true, awaiting_semantic_resolution: true,
    });
    session.diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_AWAITING_SEMANTIC_RESOLUTION_V41", {
      contextual_authority: "MAIN_CONVERSATION_MODEL", transcript_resolution: "NOT_RULE_CLASSIFIED",
      context_preserved: true, confirmation_question_emitted: false,
      dedicated_post_transcript_decision: false, phrase_enumeration_used: false,
    });
  }

  private submitEndCallToolResultV41(callId: string | undefined, output: Record<string, unknown>): void {
    realtimeCommandPortFor(this as any).submitToolResult({ callId, toolName: END_CALL, output });
  }

  private emitCourtesyFollowupV41(callId: string | undefined): void {
    const session = this as any;
    this.submitEndCallToolResultV41(callId, {
      ok: true, status: "COURTESY_FOLLOWUP_REQUIRED",
      instruction: "El usuario fue cortés pero no expresó intención de cierre. Pregunta si puedes ayudarle en algo más y continúa la conversación.",
    });
    realtimeCommandPortFor(session).speak({
      instructions: COURTESY_FOLLOWUP_INSTRUCTION, tools: "DISABLED", isolated: true,
      purpose: "courtesy_followup_v41", metadata: { authority: "closing_consensus_v41", courtesy: true, close_intent: "ABSTAIN" },
    });
    this.markMoreHelpQuestionV41("COURTESY_FOLLOWUP_V41");
    session.diagnostics?.checkpoint?.("COURTESY_FOLLOWUP_REQUESTED_V41", {
      courtesy: true, controller_close_intent: "ABSTAIN", lucia_close_proposal_redirected: true,
      close_confirmation_asked: false, next_action: "ASK_IF_MORE_HELP_NEEDED", tools_disabled: true,
    });
    closingSessionRuntimeFor(this).resetControllerAssessment();
  }

  private emitAmbiguousConfirmationV41(callId: string | undefined, modelConfirmed: boolean | null): void {
    this.moreHelpAnswerPendingV41 = false;
    this.moreHelpSemanticResolutionPendingV41 = false;
    const closing = closingSessionRuntimeFor(this);
    closing.setConfirmationPending(true);
    const assessment = closing.controllerAssessment();
    const session = this as any;
    this.submitEndCallToolResultV41(callId, {
      ok: true, status: "CLOSE_INTENT_AMBIGUOUS",
      instruction: "Lucía detectó cierre pero el controlador no confirmó una intención clara. La capa de cierre preguntará al usuario si quiere terminar y esperará su respuesta.",
    });
    realtimeCommandPortFor(session).speak({
      instructions: `Pronuncia exactamente esta pregunta y nada más: ${JSON.stringify(CLOSE_CONFIRMATION_PROMPT)}`,
      exactText: CLOSE_CONFIRMATION_PROMPT, tools: "DISABLED", isolated: true,
      purpose: "close_intent_ambiguity_v41", metadata: { authority: "closing_session_runtime", pending_close: true },
    });
    session.diagnostics?.checkpoint?.("CLOSE_INTENT_AMBIGUOUS_V41", {
      lucia_signal: "CLOSE", controller_close_intent: assessment.closeIntent, courtesy: assessment.courtesy,
      model_confirmed: modelConfirmed,
      next_action: "ASK_CALLER", confirmation_prompt: CLOSE_CONFIRMATION_PROMPT,
      tool_choice: "none", presence_must_not_resolve: true, restaurant_input_ignored_forbidden: true,
    });
  }

  private acknowledgePendingEndCallV41(callId: string | undefined): void {
    this.submitEndCallToolResultV41(callId, {
      ok: true, status: "CLOSE_INTENT_CONFIRMATION_PENDING",
      instruction: "La pregunta de cierre ya está pendiente. Espera la respuesta del usuario.",
    });
    (this as any).diagnostics?.checkpoint?.("CLOSE_INTENT_DUPLICATE_SUPPRESSED_V41", {
      confirmation_still_pending: true, response_create_emitted: false,
    });
  }

  private rejectContradictedEndCallV41(callId: string | undefined): void {
    this.submitEndCallToolResultV41(callId, {
      ok: true,
      status: "CLOSE_INTENT_REJECTED_BY_CALLER_CONTINUATION",
      instruction: "El usuario indicó que quiere continuar. No termines la llamada y atiende su petición.",
    });
    const closing = closingSessionRuntimeFor(this);
    closing.setConfirmationPending(false);
    closing.resetControllerAssessment();
    (this as any).diagnostics?.checkpoint?.("CLOSE_INTENT_REJECTED_V41", {
      lucia_signal: "CLOSE",
      model_confirmed: true,
      controller_close_intent: "CONTINUE",
      caller_continuation_prevailed: true,
    });
  }

  private acknowledgeContextualReplyPendingV41(callId: string | undefined): void {
    this.submitEndCallToolResultV41(callId, {
      ok: true, status: "CONTEXTUAL_CLOSE_REPLY_PENDING",
      instruction: "La respuesta del usuario a tu pregunta de continuidad es la autoridad de este turno. No generes otra pregunta de cierre.",
    });
    (this as any).diagnostics?.checkpoint?.("PREMATURE_END_CALL_SUPERSEDED_BY_MORE_HELP_CONTEXT_V41", {
      contextual_authority: "MORE_HELP_REPLY", arbitration_started: false, extra_audio_emitted: false, artificial_wait_ms: 0,
    });
  }

  private resolveContextualSemanticEndCallV41(callId: string | undefined, modelConfirmed: boolean | null): boolean {
    if (!this.moreHelpSemanticResolutionPendingV41) return false;
    this.moreHelpSemanticResolutionPendingV41 = false;
    const session = this as any;
    if (modelConfirmed !== true) {
      session.diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_SEMANTIC_CONTEXT_RELEASED_V41", {
        reason: "END_CALL_NOT_CONFIRMED", model_confirmed: modelConfirmed, contextual_close_committed: false,
      });
      return false;
    }
    this.moreHelpAnswerPendingV41 = false;
    const closing = closingSessionRuntimeFor(this);
    closing.setConfirmationPending(false);
    closing.setControllerAssessment({ courtesy: false, closeIntent: "CLOSE" });
    this.submitEndCallToolResultV41(callId, { ok: true, status: "CONTEXTUAL_CLOSE_RESOLVED", speak: false, mutation: false });
    session.diagnostics?.checkpoint?.("CONTEXTUAL_CLOSE_RESOLVED_V41", {
      context: "ANSWER_TO_MORE_HELP_QUESTION", caller_resolution: "NO_MORE_HELP",
      resolution_source: "LUCIA_CONFIRMED_END_CALL_AFTER_UNRESOLVED_CONTEXTUAL_TRANSCRIPT",
      arbitration_required: false, explicit_close_confirmation_required: false,
    });
    this.commitCloseV41("contextual_close_semantic_resolution_v41", "lucia_confirmed_contextual_end_call_v41");
    return true;
  }

  private recordUserTranscriptV41(transcript: string): void {
    this.lastUserTranscriptV41 = transcript;
    const assessment = assessControllerCloseIntent(transcript);
    closingSessionRuntimeFor(this).setControllerAssessment(assessment);
    (this as any).diagnostics?.checkpoint?.("CONTROLLER_CLOSE_ASSESSMENT_V41", {
      close_intent: assessment.closeIntent, courtesy: assessment.courtesy, courtesy_is_independent_dimension: true,
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const providerEvents = adaptRealtimeProviderEvents(data);
    for (const event of providerEvents) {
      if (event.type === "ASSISTANT_TRANSCRIPT_COMPLETED") {
        const assistantTranscript = usableTranscript(event.transcript);
        if (assistantTranscript && isAssistantMoreHelpQuestion(assistantTranscript)) this.markMoreHelpQuestionV41("LUCIA_ASSISTANT_TRANSCRIPT", assistantTranscript);
      }
      if (event.type === "CALLER_TRANSCRIPT_COMPLETED") {
        const transcript = usableTranscript(event.transcript);
        if (transcript) {
          const effectiveTranscript = callerTurnContextRuntimeFor(this).current() || transcript;
          if (this.moreHelpAnswerPendingV41) {
            this.resolveMoreHelpAnswerV41();
          }
          this.recordUserTranscriptV41(effectiveTranscript);
        }
      }
      if (event.type === "SEMANTIC_TOOL_SELECTED" && this.moreHelpSemanticResolutionPendingV41 && event.name !== END_CALL && event.name !== "restaurant_input_ignored") {
        this.moreHelpSemanticResolutionPendingV41 = false;
        (this as any).diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_SEMANTIC_CONTEXT_RELEASED_V41", {
          reason: "SUBSTANTIVE_TOOL_SELECTED", tool: event.name,
          contextual_close_committed: false, lower_semantic_pipeline_preserved: true,
        });
      }
      if (event.type === "SEMANTIC_TOOL_SELECTED" && event.name === END_CALL) {
        const session = this as any;
        if (conversationLifecyclePortFor(this).isTerminal()) return;
        const modelConfirmed = readEndCallConfirmedV41(event.arguments);
        if (this.moreHelpSemanticResolutionPendingV41 && this.resolveContextualSemanticEndCallV41(event.callId, modelConfirmed)) return;
        if (this.moreHelpAnswerPendingV41) { this.acknowledgeContextualReplyPendingV41(event.callId); return; }
        const closing = closingSessionRuntimeFor(this);
        if (closing.isConfirmationPending()) { this.acknowledgePendingEndCallV41(event.callId); return; }
        if (modelConfirmed !== true) { this.emitAmbiguousConfirmationV41(event.callId, modelConfirmed); return; }
        const assessment = closing.controllerAssessment();
        const decision = decideCloseConsensus(closing.isConfirmationPending(), assessment, true);
        if (decision.action === "ACK_PENDING") { this.acknowledgePendingEndCallV41(event.callId); return; }
        if (decision.action === "COURTESY_FOLLOWUP") { this.emitCourtesyFollowupV41(event.callId); return; }
        if (decision.action === "AMBIGUOUS_CONFIRM") { this.emitAmbiguousConfirmationV41(event.callId, true); return; }
        if (decision.action === "CONTINUE") { this.rejectContradictedEndCallV41(event.callId); return; }
        session.diagnostics?.checkpoint?.("CLOSE_CONSENSUS_REACHED_V41", {
          lucia_signal: "CLOSE", controller_close_intent: assessment.closeIntent,
          model_confirmed: true, courtesy: assessment.courtesy,
          consensus: decision.action === "CONSENSUS_CLOSE",
          strong_close_consensus: decision.action === "CONSENSUS_CLOSE",
          semantic_close_without_controller_conflict: decision.action === "SEMANTIC_CLOSE",
          last_user_transcript_present: Boolean(this.lastUserTranscriptV41),
        });
        closing.setConfirmationPending(false);
        this.moreHelpAnswerPendingV41 = false;
        this.moreHelpSemanticResolutionPendingV41 = false;
        closing.resetControllerAssessment();
      }
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
