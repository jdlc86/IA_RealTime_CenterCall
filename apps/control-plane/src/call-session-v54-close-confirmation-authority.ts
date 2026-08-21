import { CallSession as CallSessionV53 } from "./call-session-v53-reservation-time-authority";
import {
  adaptRealtimeProviderEvents,
  clearConsolidatedCallerTurnForNextResponse,
  realtimeCommandPortFor,
  stageConsolidatedCallerTurnForNextResponse,
} from "./realtime-provider-runtime.js";
import {
  initialCallerTurnFragmentState,
  observeCallerSpeechStarted,
  observeCallerTranscriptCompleted,
  type CallerTurnFragmentState,
} from "./caller-turn-fragment-coordinator.js";
import {
  observeGovernedSpeechAfterLowerLayers,
  observeGovernedSpeechBeforeLowerLayers,
} from "./governed-speech-liveness-coordinator.js";
import { isExplicitClosingConfirmation, isExplicitClosingRejection } from "./core-closing-policy.js";
import { callerTurnContextRuntimeFor } from "./caller-turn-context-runtime.js";
import { closingSessionRuntimeFor } from "./closing-session-runtime.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";

const BaseConstructor = CallSessionV53 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV53.prototype as any;

function usableTranscript(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 3000) : "";
}

/**
 * Top compatibility adapter. It hosts composed coordinators but owns no shared
 * closing/caller-turn state and must not grow another inheritance generation.
 */
export class CallSession extends BaseConstructor {
  private callerTurnFragmentsV54: CallerTurnFragmentState = initialCallerTurnFragmentState();

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const events = adaptRealtimeProviderEvents(data);
    const session = this as any;
    const turnContext = callerTurnContextRuntimeFor(this);
    const closing = closingSessionRuntimeFor(this);
    observeGovernedSpeechBeforeLowerLayers(session, events);

    for (const event of events) {
      if (event.type === "CALLER_SPEECH_STARTED") {
        clearConsolidatedCallerTurnForNextResponse(session);
        turnContext.clear();
        this.callerTurnFragmentsV54 = observeCallerSpeechStarted(this.callerTurnFragmentsV54, event.itemId);
      }
    }

    const callerTurn = events.find((event) => event.type === "CALLER_TRANSCRIPT_COMPLETED");
    let consolidatedCallerTurn: string | null = null;
    if (callerTurn?.type === "CALLER_TRANSCRIPT_COMPLETED") {
      const fragmentDecision = observeCallerTranscriptCompleted(this.callerTurnFragmentsV54, {
        itemId: callerTurn.itemId,
        transcript: callerTurn.transcript,
      });
      this.callerTurnFragmentsV54 = fragmentDecision.next;
      if (fragmentDecision.action === "DEFER") {
        session.diagnostics?.checkpoint?.("CALLER_TURN_FRAGMENT_DEFERRED_V54", {
          item_id: callerTurn.itemId ?? null,
          authority: "structural_split_turn_evidence",
          timer_used: false,
          semantic_response_requested: false,
        });
        // V54 is the top structural authority for split caller turns. A deferred
        // fragment must not reach any lower semantic layer; the completed turn
        // will be forwarded once the active fragment arrives and is consolidated.
        turnContext.clear();
        return;
      } else {
        consolidatedCallerTurn = usableTranscript(fragmentDecision.transcript);
        if (consolidatedCallerTurn) {
          turnContext.setEffectiveTurn(consolidatedCallerTurn, fragmentDecision.fragmentCount);
          if (fragmentDecision.fragmentCount > 1) stageConsolidatedCallerTurnForNextResponse(session, consolidatedCallerTurn);
          session.diagnostics?.checkpoint?.("CALLER_TURN_CONSOLIDATED_V54", {
            item_id: callerTurn.itemId ?? null,
            fragment_count: fragmentDecision.fragmentCount,
            split_turn_consolidated: fragmentDecision.fragmentCount > 1,
            semantic_response_context_staged: fragmentDecision.fragmentCount > 1,
            timer_used: false,
            context_owner: "caller_turn_context_runtime",
          });
        }
      }
    }

    const effectiveCallerTurn = consolidatedCallerTurn
      || (callerTurn?.type === "CALLER_TRANSCRIPT_COMPLETED" ? usableTranscript(callerTurn.transcript) : "");

    if (effectiveCallerTurn && closing.isConfirmationPending()) {
      clearConsolidatedCallerTurnForNextResponse(session);
      if (isExplicitClosingConfirmation(effectiveCallerTurn)) {
        closing.setConfirmationPending(false);
        closing.setControllerAssessment({ courtesy: false, closeIntent: "CLOSE" });
        session.diagnostics?.checkpoint?.("CLOSE_CONFIRMATION_AUTHORITY_CONSUMED_V54", {
          caller_resolution: "CLOSE",
          pending_preserved_until_caller_turn: true,
          generic_semantic_pipeline_bypassed: true,
          state_owner: "closing_session_runtime",
        });
        turnContext.clear();
        conversationLifecyclePortFor(this).confirmEndCall(
          "agent_end_confirmed_v54",
          "caller_resolved_pending_close_v54",
        );
        return;
      }

      if (isExplicitClosingRejection(effectiveCallerTurn)) {
        closing.setConfirmationPending(false);
        closing.setControllerAssessment({ courtesy: false, closeIntent: "CONTINUE" });
        session.diagnostics?.checkpoint?.("CLOSE_CONFIRMATION_AUTHORITY_CONSUMED_V54", {
          caller_resolution: "CONTINUE",
          pending_cleared_by_caller_only: true,
          generic_semantic_pipeline_preserved: true,
          state_owner: "closing_session_runtime",
        });
        try { await BasePrototype.handleRealtimeMessage.call(this, data); }
        finally { turnContext.clear(); }
        return;
      }

      session.diagnostics?.checkpoint?.("CLOSE_CONFIRMATION_AMBIGUOUS_PRESERVED_V54", {
        pending_close: true,
        generic_semantic_pipeline_bypassed: true,
        clarification_tools_disabled: true,
        state_owner: "closing_session_runtime",
      });
      turnContext.clear();
      realtimeCommandPortFor(session).speak({
        instructions: "La confirmación de cierre sigue pendiente. Pide únicamente una aclaración breve de sí o no. No llames herramientas en esta respuesta.",
        exactText: "No he entendido si quieres terminar la llamada. ¿Sí o no?",
        tools: "DISABLED",
        isolated: true,
        purpose: "close_confirmation_clarification_v54",
        metadata: { authority: "closing_session_runtime", pending_close: true, tools_disabled: true },
      });
      return;
    }

    try {
      await BasePrototype.handleRealtimeMessage.call(this, data);
      observeGovernedSpeechAfterLowerLayers(session, events);
    } finally {
      turnContext.clear();
    }
  }
}
