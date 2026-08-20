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
  parseContextualMoreHelpSemanticDecision,
  resolveReplyToMoreHelpQuestion,
} from "./core-closing-policy.js";
import { closingSessionRuntimeFor } from "./closing-session-runtime.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";

const BaseConstructor = CallSessionV40 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV40.prototype as any;
const END_CALL = "restaurant_end_call";
const CLOSE_CONFIRMATION_PROMPT = "¿Quieres terminar la llamada?";
const COURTESY_FOLLOWUP_INSTRUCTION = "Responde de forma breve y natural preguntando si puedes ayudar al usuario en algo más. No menciones terminar, colgar ni cerrar la llamada.";
const CONTEXTUAL_MORE_HELP_DECISION_PURPOSE = "contextual_more_help_resolution_v41";
const CONTEXTUAL_MORE_HELP_DECISION_INSTRUCTIONS =
  "Decide únicamente qué significa la respuesta del usuario a la pregunta de si necesita algo más. " +
  "Responde exactamente CLOSE si rechaza más ayuda, indica que no necesita nada más, se despide, da la conversación por terminada o pide colgar. " +
  "Responde exactamente CONTINUE si acepta o pide más ayuda, formula una nueva petición, corrige algo, quiere continuar o la intención no está clara. " +
  "Si hay cualquier duda, responde CONTINUE. No expliques la decisión.";
const CLOSING_GUIDANCE_START = "[[V41_CLOSING_GUIDANCE_START]]";
const CLOSING_GUIDANCE_END = "[[V41_CLOSING_GUIDANCE_END]]";
const CLOSING_GUIDANCE = `${CLOSING_GUIDANCE_START}\nPROTOCOLO NATURAL DE CIERRE:\n- La cortesía y la intención de cierre son dimensiones distintas. Un simple agradecimiento NO implica cierre: pregunta de forma natural si puedes ayudar en algo más.\n- Si acabas de preguntar si el usuario necesita algo más y responde negativamente (por ejemplo 'no, gracias' o 'nada más'), ese contexto YA resuelve el cierre: despídete de forma natural y termina la llamada; no vuelvas a preguntar si quiere terminar.\n- Una frase puede contener cortesía y cierre a la vez. Por ejemplo 'muchas gracias, no necesito nada más' o 'gracias, hasta luego' expresa cierre claro: puedes proponer restaurant_end_call.\n- Para un cierre espontáneo, si tú y el controlador detectáis CLOSE hay consenso fuerte y se cierra. Solo si tú propones cierre y el controlador no lo confirma se pedirá '¿Quieres terminar la llamada?'; esa ruta debe ser excepcional.\n- Si el usuario corrige el cierre con una nueva petición ('hasta luego... espera, una cosa más'), prevalece la nueva petición.\n- Nunca uses restaurant_input_ignored para resolver una intención de cierre.\n${CLOSING_GUIDANCE_END}`;

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
  private contextualMoreHelpDecisionSourceIdV41: string | null = null;
  private contextualMoreHelpDecisionByResponseV41 = new Map<string, string>();
  private contextualMoreHelpDecisionOwnedResponseIdsV41 = new Set<string>();
  private contextualMoreHelpDecisionFinalizedResponseIdsV41 = new Set<string>();
  private contextualMoreHelpDecisionSequenceV41 = 0;
  private lastUserTranscriptV41 = "";
  private closingSendBoundaryInstalledV41 = false;
  private originalSendV41: ((message: unknown) => void) | null = null;

  private installClosingGuidanceBoundaryV41(): void {
    if (this.closingSendBoundaryInstalledV41) return;
    const session = this as any;
    const currentSend = session.send;
    if (typeof currentSend !== "function") return;
    this.closingSendBoundaryInstalledV41 = true;
    installRealtimeSessionPolicyTransform(session, (update) => {
      if (typeof update.instructions !== "string") return update;
      return { ...update, instructions: withClosingGuidance(update.instructions) };
    });
    this.originalSendV41 = currentSend.bind(this);
    session.send = (message: any) => {
      if (message?.type === "session.update" && typeof message?.session?.instructions === "string") {
        this.originalSendV41?.({ ...message, session: { ...message.session, instructions: withClosingGuidance(message.session.instructions) } });
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

  private requestContextualMoreHelpDecisionV41(transcript: string, itemId?: string): void {
    const session = this as any;
    const sourceItemId = itemId?.trim() || `more_help_reply_v41_${++this.contextualMoreHelpDecisionSequenceV41}`;
    this.contextualMoreHelpDecisionSourceIdV41 = sourceItemId;
    realtimeCommandPortFor(session).requestTextDecision({
      purpose: CONTEXTUAL_MORE_HELP_DECISION_PURPOSE,
      metadata: { source_item_id: sourceItemId }, maxOutputTokens: 8,
      instructions: CONTEXTUAL_MORE_HELP_DECISION_INSTRUCTIONS,
      inputText: `Respuesta del usuario: ${JSON.stringify(transcript)}`,
    });
    session.diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_DECISION_REQUESTED_V41", {
      source_item_id_present: Boolean(itemId), transcript_length: transcript.length,
      provider_command_port: true, fail_safe_decision: "CONTINUE",
    });
  }

  private finalizeContextualMoreHelpDecisionV41(responseId: string, text: unknown): void {
    if (this.contextualMoreHelpDecisionFinalizedResponseIdsV41.has(responseId)) return;
    this.contextualMoreHelpDecisionFinalizedResponseIdsV41.add(responseId);
    const sourceItemId = this.contextualMoreHelpDecisionByResponseV41.get(responseId) ?? "";
    const session = this as any;
    if (!sourceItemId || !this.moreHelpSemanticResolutionPendingV41 || !this.contextualMoreHelpDecisionSourceIdV41 || sourceItemId !== this.contextualMoreHelpDecisionSourceIdV41) {
      session.diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_DECISION_STALE_V41", {
        response_id: responseId,
        source_item_matches_pending: Boolean(sourceItemId && sourceItemId === this.contextualMoreHelpDecisionSourceIdV41),
        contextual_resolution_pending: this.moreHelpSemanticResolutionPendingV41, ignored: true,
      });
      return;
    }
    const decision = parseContextualMoreHelpSemanticDecision(text);
    this.moreHelpSemanticResolutionPendingV41 = false;
    this.contextualMoreHelpDecisionSourceIdV41 = null;
    if (decision === "CLOSE") {
      this.moreHelpAnswerPendingV41 = false;
      const closing = closingSessionRuntimeFor(this);
      closing.setConfirmationPending(false);
      closing.setControllerAssessment({ courtesy: false, closeIntent: "CLOSE" });
      session.diagnostics?.checkpoint?.("CONTEXTUAL_CLOSE_RESOLVED_V41", {
        context: "ANSWER_TO_MORE_HELP_QUESTION", caller_resolution: "NO_MORE_HELP",
        resolution_source: "DEDICATED_MORE_HELP_DECISION_V41", arbitration_required: false,
        explicit_close_confirmation_required: false,
      });
      this.commitCloseV41("contextual_close_dedicated_semantic_resolution_v41", "dedicated_more_help_decision_v41");
      return;
    }
    session.diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_SEMANTIC_CONTEXT_RELEASED_V41", {
      reason: "DEDICATED_DECISION_CONTINUE_OR_UNCLEAR", contextual_close_committed: false,
      context_leaked_to_next_turn: false, lower_semantic_pipeline_preserved: true,
    });
  }

  private resolveMoreHelpAnswerV41(transcript: string, itemId?: string): boolean {
    if (!this.moreHelpAnswerPendingV41) return false;
    const resolution = resolveReplyToMoreHelpQuestion(transcript);
    const session = this as any;
    if (resolution === "CLOSE") {
      this.moreHelpAnswerPendingV41 = false;
      this.moreHelpSemanticResolutionPendingV41 = false;
      this.contextualMoreHelpDecisionSourceIdV41 = null;
      const closing = closingSessionRuntimeFor(this);
      closing.setConfirmationPending(false);
      closing.setControllerAssessment({ courtesy: /gracias/i.test(transcript), closeIntent: "CLOSE" });
      session.diagnostics?.checkpoint?.("CONTEXTUAL_CLOSE_RESOLVED_V41", {
        context: "ANSWER_TO_MORE_HELP_QUESTION", caller_resolution: "NO_MORE_HELP",
        arbitration_required: false, explicit_close_confirmation_required: false,
      });
      this.commitCloseV41("contextual_close_resolved_v41", "caller_declined_more_help_v41");
      return true;
    }
    if (resolution === "CONTINUE") {
      this.moreHelpAnswerPendingV41 = false;
      this.moreHelpSemanticResolutionPendingV41 = false;
      this.contextualMoreHelpDecisionSourceIdV41 = null;
      session.diagnostics?.checkpoint?.("MORE_HELP_QUESTION_RESOLVED_V41", {
        caller_resolution: resolution, close_committed: false, context_preserved: false,
      });
      return false;
    }
    this.moreHelpAnswerPendingV41 = false;
    this.moreHelpSemanticResolutionPendingV41 = true;
    session.diagnostics?.checkpoint?.("MORE_HELP_QUESTION_RESOLVED_V41", {
      caller_resolution: resolution, close_committed: false, context_preserved: true, awaiting_semantic_resolution: true,
    });
    session.diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_AWAITING_SEMANTIC_RESOLUTION_V41", {
      contextual_authority: "MORE_HELP_REPLY", transcript_resolution: "UNRESOLVED",
      context_preserved: true, confirmation_question_emitted: false, dedicated_post_transcript_decision: true,
    });
    this.requestContextualMoreHelpDecisionV41(transcript, itemId);
    return false;
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

  private emitAmbiguousConfirmationV41(callId: string | undefined): void {
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
    this.contextualMoreHelpDecisionSourceIdV41 = null;
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
      const responseId = "responseId" in event && typeof event.responseId === "string" ? event.responseId : "";
      if (event.type === "ASSISTANT_RESPONSE_STARTED" && event.purpose === CONTEXTUAL_MORE_HELP_DECISION_PURPOSE) {
        if (responseId) {
          const sourceItemId = event.sourceItemId ?? "";
          this.contextualMoreHelpDecisionOwnedResponseIdsV41.add(responseId);
          this.contextualMoreHelpDecisionByResponseV41.set(responseId, sourceItemId);
          (this as any).diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_DECISION_BOUND_V41", {
            response_id: responseId,
            source_item_matches_pending: Boolean(sourceItemId && this.contextualMoreHelpDecisionSourceIdV41 && sourceItemId === this.contextualMoreHelpDecisionSourceIdV41),
            provider_neutral_event: event.type,
          });
        }
        return;
      }
      if (event.type === "TEXT_DECISION_COMPLETED" && responseId && this.contextualMoreHelpDecisionOwnedResponseIdsV41.has(responseId)) {
        this.finalizeContextualMoreHelpDecisionV41(responseId, event.text); return;
      }
      if (event.type === "ASSISTANT_RESPONSE_COMPLETED" && responseId && this.contextualMoreHelpDecisionOwnedResponseIdsV41.has(responseId)) {
        if (!this.contextualMoreHelpDecisionFinalizedResponseIdsV41.has(responseId)) this.finalizeContextualMoreHelpDecisionV41(responseId, "CONTINUE");
        this.contextualMoreHelpDecisionByResponseV41.delete(responseId); return;
      }
      if (event.type === "ASSISTANT_TRANSCRIPT_COMPLETED") {
        const assistantTranscript = usableTranscript(event.transcript);
        if (assistantTranscript && isAssistantMoreHelpQuestion(assistantTranscript)) this.markMoreHelpQuestionV41("LUCIA_ASSISTANT_TRANSCRIPT", assistantTranscript);
      }
      if (event.type === "CALLER_TRANSCRIPT_COMPLETED") {
        const transcript = usableTranscript(event.transcript);
        if (transcript) {
          if (this.moreHelpAnswerPendingV41 && this.resolveMoreHelpAnswerV41(transcript, event.itemId)) return;
          this.recordUserTranscriptV41(transcript);
        }
      }
      if (event.type === "SEMANTIC_TOOL_SELECTED" && this.moreHelpSemanticResolutionPendingV41 && event.name !== END_CALL && event.name !== "restaurant_input_ignored") {
        this.moreHelpSemanticResolutionPendingV41 = false;
        this.contextualMoreHelpDecisionSourceIdV41 = null;
        (this as any).diagnostics?.checkpoint?.("CONTEXTUAL_MORE_HELP_SEMANTIC_CONTEXT_RELEASED_V41", {
          reason: "SUBSTANTIVE_TOOL_SELECTED", tool: event.name,
          contextual_close_committed: false, lower_semantic_pipeline_preserved: true,
        });
      }
      if (event.type === "SEMANTIC_TOOL_SELECTED" && event.name === END_CALL) {
        const session = this as any;
        if (session.state === "closing" || session.hangupStarted) return;
        const modelConfirmed = readEndCallConfirmedV41(event.arguments);
        if (this.moreHelpSemanticResolutionPendingV41 && this.resolveContextualSemanticEndCallV41(event.callId, modelConfirmed)) return;
        if (this.moreHelpAnswerPendingV41) { this.acknowledgeContextualReplyPendingV41(event.callId); return; }
        const closing = closingSessionRuntimeFor(this);
        const assessment = closing.controllerAssessment();
        const decision = decideCloseConsensus(closing.isConfirmationPending(), assessment, true);
        if (decision.action === "ACK_PENDING") { this.acknowledgePendingEndCallV41(event.callId); return; }
        if (decision.action === "COURTESY_FOLLOWUP") { this.emitCourtesyFollowupV41(event.callId); return; }
        if (decision.action === "AMBIGUOUS_CONFIRM") { this.emitAmbiguousConfirmationV41(event.callId); return; }
        session.diagnostics?.checkpoint?.("CLOSE_CONSENSUS_REACHED_V41", {
          lucia_signal: "CLOSE", controller_close_intent: assessment.closeIntent,
          courtesy: assessment.courtesy, consensus: true, strong_close_consensus: true,
          last_user_transcript_present: Boolean(this.lastUserTranscriptV41),
        });
        closing.setConfirmationPending(false);
        this.moreHelpAnswerPendingV41 = false;
        this.moreHelpSemanticResolutionPendingV41 = false;
        this.contextualMoreHelpDecisionSourceIdV41 = null;
        closing.resetControllerAssessment();
      }
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
