import { CallSession as CallSessionV50 } from "./call-session-v50-reservation-date-scope";
import {
  decideMalformedToolCorrection,
  initialMalformedToolCorrectionState,
  observeCallerSpeechAfterMalformedRecovery,
  observeCallerTranscriptAfterMalformedRecovery,
  observeMalformedToolRecoveryPlaybackCompleted,
  type MalformedToolCorrectionState,
} from "./malformed-tool-correction-policy";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";

const BaseConstructor = CallSessionV50 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV50.prototype as any;
const MALFORMED_TOOL_RECOVERY_PURPOSE = "malformed_tool_cross_tool_recovery";

type RealtimeToolEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

/**
 * V51 closes the liveness/authority hole between V29 semantic uniqueness and
 * lower argument validation.
 *
 * Malformed arguments cannot execute a business action and therefore do not
 * consume V29's authoritative slot. They establish same-intervention tool
 * affinity: only the same tool may repair its serialization. A different tool
 * is rejected with one isolated, tool-disabled recovery. The affinity is reset
 * only after that exact recovery has finished playback and a fresh caller
 * speech+transcript pair arrives. Late/split transcripts alone cannot reset it.
 */
export class CallSession extends BaseConstructor {
  private malformedToolCorrectionV51: MalformedToolCorrectionState = initialMalformedToolCorrectionState();
  private malformedRecoveryResponseIdV51: string | null = null;

  protected authorizePublicRestaurantToolV29(event: RealtimeToolEvent): boolean {
    if (!event.name) return BasePrototype.authorizePublicRestaurantToolV29.call(this, event);

    const recoveryAlreadyRequired = this.malformedToolCorrectionV51.recoveryRequired;
    const decision = decideMalformedToolCorrection(
      this.malformedToolCorrectionV51,
      event.name,
      event.arguments,
    );
    this.malformedToolCorrectionV51 = decision.next;

    if (decision.action === "PASS_INVALID_WITHOUT_CONSUMING") {
      (this as any).diagnostics?.checkpoint?.("SEMANTIC_TOOL_INVALID_ARGUMENTS_NOT_CONSUMED_V51", {
        tool: event.name,
        call_id: event.call_id ?? null,
        semantic_decision_consumed: false,
        business_action_executed: false,
        lower_argument_validation_preserved: true,
        correction_affinity: event.name,
      });
      return true;
    }

    if (decision.action === "REJECT_CROSS_TOOL_CORRECTION") {
      (this as any).diagnostics?.checkpoint?.("SEMANTIC_TOOL_CROSS_TOOL_CORRECTION_BLOCKED_V51", {
        attempted_tool: event.name,
        pending_malformed_tool: this.malformedToolCorrectionV51.pendingMalformedTool,
        same_caller_intervention: true,
        semantic_decision_consumed: false,
        business_action_executed: false,
        recovery_already_required: recoveryAlreadyRequired,
      });
      const port = realtimeCommandPortFor(this as any);
      port.submitToolResult({
        callId: event.call_id,
        toolName: event.name,
        output: {
          ok: false,
          status: "REJECTED",
          reason: "MALFORMED_TOOL_CORRECTION_MISMATCH",
          expected_tool: this.malformedToolCorrectionV51.pendingMalformedTool,
          attempted_tool: event.name,
          business_action_executed: false,
        },
      });
      if (!recoveryAlreadyRequired) {
        port.speak({
          instructions: "Pide al caller que repita qué quiere hacer. No ejecutes ninguna herramienta ni supongas la acción pretendida.",
          exactText: "No he podido validar esa acción con seguridad. ¿Puedes repetirme qué quieres hacer?",
          isolated: true,
          tools: "DISABLED",
          purpose: MALFORMED_TOOL_RECOVERY_PURPOSE,
          metadata: {
            v51: "cross_tool_correction_blocked",
            business_action_executed: "false",
          },
        });
      }
      return false;
    }

    if (decision.action === "PASS_VALID_CORRECTION_TO_V29") {
      this.malformedRecoveryResponseIdV51 = null;
      (this as any).diagnostics?.checkpoint?.("SEMANTIC_TOOL_VALID_CORRECTION_RELEASED_TO_V29_V51", {
        tool: event.name,
        call_id: event.call_id ?? null,
        same_tool_correction: true,
      });
    }

    return BasePrototype.authorizePublicRestaurantToolV29.call(this, event);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const events = adaptRealtimeProviderEvents(data);

    for (const event of events) {
      if (
        event.type === "ASSISTANT_RESPONSE_STARTED" &&
        event.purpose === MALFORMED_TOOL_RECOVERY_PURPOSE &&
        event.responseId
      ) {
        this.malformedRecoveryResponseIdV51 = event.responseId;
        (this as any).diagnostics?.checkpoint?.("SEMANTIC_TOOL_RECOVERY_RESPONSE_BOUND_V51", {
          response_id: event.responseId,
          pending_malformed_tool: this.malformedToolCorrectionV51.pendingMalformedTool,
        });
        continue;
      }

      if (
        event.type === "ASSISTANT_AUDIO_STOPPED" &&
        this.malformedRecoveryResponseIdV51 &&
        event.responseId === this.malformedRecoveryResponseIdV51
      ) {
        this.malformedToolCorrectionV51 = observeMalformedToolRecoveryPlaybackCompleted(
          this.malformedToolCorrectionV51,
        );
        (this as any).diagnostics?.checkpoint?.("SEMANTIC_TOOL_RECOVERY_PLAYBACK_COMPLETED_V51", {
          response_id: event.responseId,
          pending_malformed_tool: this.malformedToolCorrectionV51.pendingMalformedTool,
          fresh_caller_turn_eligible: this.malformedToolCorrectionV51.recoveryPlaybackCompleted,
        });
        this.malformedRecoveryResponseIdV51 = null;
        continue;
      }

      if (event.type === "CALLER_SPEECH_STARTED") {
        const before = this.malformedToolCorrectionV51.postRecoveryCallerSpeechObserved;
        this.malformedToolCorrectionV51 = observeCallerSpeechAfterMalformedRecovery(
          this.malformedToolCorrectionV51,
        );
        if (!before && this.malformedToolCorrectionV51.postRecoveryCallerSpeechObserved) {
          (this as any).diagnostics?.checkpoint?.("SEMANTIC_TOOL_POST_RECOVERY_CALLER_SPEECH_V51", {
            item_id: event.itemId ?? null,
            pending_malformed_tool: this.malformedToolCorrectionV51.pendingMalformedTool,
          });
        }
        continue;
      }

      if (event.type === "CALLER_TRANSCRIPT_COMPLETED") {
        const previousTool = this.malformedToolCorrectionV51.pendingMalformedTool;
        this.malformedToolCorrectionV51 = observeCallerTranscriptAfterMalformedRecovery(
          this.malformedToolCorrectionV51,
        );
        if (previousTool && !this.malformedToolCorrectionV51.pendingMalformedTool) {
          (this as any).diagnostics?.checkpoint?.("SEMANTIC_TOOL_MALFORMED_AFFINITY_RESET_V51", {
            previous_tool: previousTool,
            item_id: event.itemId ?? null,
            authority: "completed_recovery_plus_fresh_caller_speech_and_transcript",
          });
        }
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
