import { CallSession as CallSessionV50 } from "./call-session-v50-reservation-date-scope";
import {
  decideMalformedToolCorrection,
  initialMalformedToolCorrectionState,
  observeCallerTurnStarted,
  type MalformedToolCorrectionState,
} from "./malformed-tool-correction-policy";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";

const BaseConstructor = CallSessionV50 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV50.prototype as any;

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
 * consume V29's authoritative slot. They do establish tool affinity for the
 * current caller turn: only the same tool may repair its serialization. A
 * different tool is rejected with an isolated, tool-disabled caller recovery
 * and must wait for fresh caller transcript evidence.
 */
export class CallSession extends BaseConstructor {
  private malformedToolCorrectionV51: MalformedToolCorrectionState = initialMalformedToolCorrectionState();

  protected authorizePublicRestaurantToolV29(event: RealtimeToolEvent): boolean {
    if (!event.name) return BasePrototype.authorizePublicRestaurantToolV29.call(this, event);

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
        same_caller_turn: true,
        semantic_decision_consumed: false,
        business_action_executed: false,
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
      port.speak({
        instructions: "Pide al caller que repita qué quiere hacer. No ejecutes ninguna herramienta ni supongas la acción pretendida.",
        exactText: "No he podido validar esa acción con seguridad. ¿Puedes repetirme qué quieres hacer?",
        isolated: true,
        tools: "DISABLED",
        purpose: "malformed_tool_cross_tool_recovery",
        metadata: {
          v51: "cross_tool_correction_blocked",
          business_action_executed: "false",
        },
      });
      return false;
    }

    if (decision.action === "PASS_VALID_CORRECTION_TO_V29") {
      (this as any).diagnostics?.checkpoint?.("SEMANTIC_TOOL_VALID_CORRECTION_RELEASED_TO_V29_V51", {
        tool: event.name,
        call_id: event.call_id ?? null,
        same_tool_correction: true,
      });
    }

    return BasePrototype.authorizePublicRestaurantToolV29.call(this, event);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const callerTranscriptCompleted = adaptRealtimeProviderEvents(data).some(
      (event) => event.type === "CALLER_TRANSCRIPT_COMPLETED",
    );
    if (callerTranscriptCompleted) {
      const pending = this.malformedToolCorrectionV51.pendingMalformedTool;
      this.malformedToolCorrectionV51 = observeCallerTurnStarted(this.malformedToolCorrectionV51);
      if (pending) {
        (this as any).diagnostics?.checkpoint?.("SEMANTIC_TOOL_MALFORMED_AFFINITY_RESET_V51", {
          previous_tool: pending,
          authority: "fresh_caller_transcript",
        });
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
