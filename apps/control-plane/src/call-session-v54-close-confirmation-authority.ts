import { CallSession as CallSessionV53 } from "./call-session-v53-reservation-time-authority";
import {
  adaptRealtimeProviderEvents,
  realtimeCommandPortFor,
} from "./realtime-provider-runtime.js";
import {
  observeGovernedSpeechAfterLowerLayers,
  observeGovernedSpeechBeforeLowerLayers,
} from "./governed-speech-liveness-coordinator.js";
import {
  isExplicitClosingConfirmation,
  isExplicitClosingRejection,
} from "./core-closing-policy.js";

const BaseConstructor = CallSessionV53 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV53.prototype as any;

function usableTranscript(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
}

/**
 * V54 closes the authority gap observed after V41 asks an explicit close
 * confirmation. While that question is pending, the next usable caller turn is
 * owned by the close-confirmation workflow and may not fall through to the
 * generic semantic pipeline.
 *
 * YES  -> commit through V41/ConversationTurnLifecycle.
 * NO   -> clear pending state and continue normally.
 * other -> keep pending state and ask one isolated clarification.
 *
 * Assistant/audio/response lifecycle events never consume this authority.
 *
 * The former V55 inheritance layer has been removed. Its response-liveness
 * boundary is now composed here without adding another CallSession subclass:
 * response START is observed before lower layers and response COMPLETED only
 * after lower layers have reconciled it.
 */
export class CallSession extends BaseConstructor {
  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const events = adaptRealtimeProviderEvents(data);
    const session = this as any;
    observeGovernedSpeechBeforeLowerLayers(session, events);

    const callerTurn = events.find((event) => event.type === "CALLER_TRANSCRIPT_COMPLETED");

    if (callerTurn?.type === "CALLER_TRANSCRIPT_COMPLETED" && session.closingConfirmationPendingV41 === true) {
      const transcript = usableTranscript(callerTurn.transcript);
      if (transcript) {
        if (isExplicitClosingConfirmation(transcript)) {
          session.closingConfirmationPendingV41 = false;
          session.controllerCloseAssessmentV41 = { courtesy: false, closeIntent: "CLOSE" };
          session.diagnostics?.checkpoint?.("CLOSE_CONFIRMATION_AUTHORITY_CONSUMED_V54", {
            caller_resolution: "CLOSE",
            pending_preserved_until_caller_turn: true,
            generic_semantic_pipeline_bypassed: true,
          });
          session.commitCloseThroughLifecycleV41?.(
            "agent_end_confirmed_v54",
            "caller_resolved_pending_close_v54",
          );
          return;
        }

        if (isExplicitClosingRejection(transcript)) {
          session.closingConfirmationPendingV41 = false;
          session.controllerCloseAssessmentV41 = { courtesy: false, closeIntent: "CONTINUE" };
          session.diagnostics?.checkpoint?.("CLOSE_CONFIRMATION_AUTHORITY_CONSUMED_V54", {
            caller_resolution: "CONTINUE",
            pending_cleared_by_caller_only: true,
            generic_semantic_pipeline_preserved: true,
          });
          await BasePrototype.handleRealtimeMessage.call(this, data);
          return;
        }

        session.diagnostics?.checkpoint?.("CLOSE_CONFIRMATION_AMBIGUOUS_PRESERVED_V54", {
          pending_close: true,
          generic_semantic_pipeline_bypassed: true,
          clarification_tools_disabled: true,
        });
        realtimeCommandPortFor(session).speak({
          instructions: "La confirmación de cierre sigue pendiente. Pide únicamente una aclaración breve de sí o no. No llames herramientas en esta respuesta.",
          exactText: "No he entendido si quieres terminar la llamada. ¿Sí o no?",
          tools: "DISABLED",
          isolated: true,
          purpose: "close_confirmation_clarification_v54",
          metadata: {
            authority: "pending_close_confirmation_v54",
            pending_close: true,
            tools_disabled: true,
          },
        });
        return;
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
    observeGovernedSpeechAfterLowerLayers(session, events);
  }
}
