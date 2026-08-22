import {
  decideMalformedToolCorrection,
  initialMalformedToolCorrectionState,
  observeCallerSpeechAfterMalformedRecovery,
  observeCallerTranscriptAfterMalformedRecovery,
  observeMalformedToolRecoveryPlaybackCompleted,
  type MalformedToolCorrectionState,
} from "./malformed-tool-correction-policy.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import { realtimeCommandPortFor } from "./realtime-provider-runtime.js";

export const MALFORMED_TOOL_RECOVERY_PURPOSE = "malformed_tool_cross_tool_recovery";

export type MalformedToolAuthorizationRequest = Readonly<{
  name: string;
  call_id?: string;
  arguments?: string;
}>;

export type MalformedToolPreauthorization =
  | "PASS_TO_SEMANTIC_AUTHORITY"
  | "ALLOW_INVALID_WITHOUT_CONSUMING"
  | "REJECT_CROSS_TOOL_CORRECTION";

/**
 * Version-neutral owner for malformed-tool affinity and recovery lifecycle.
 * Invalid JSON is allowed to reach lower argument validation without consuming
 * semantic authority. A different tool cannot replace that malformed intent
 * until the isolated recovery finishes and a fresh caller speech+transcript
 * boundary is observed.
 */
export class MalformedToolCorrectionRuntime {
  private state: MalformedToolCorrectionState = initialMalformedToolCorrectionState();
  private recoveryResponseId: string | null = null;

  snapshot(): MalformedToolCorrectionState {
    return { ...this.state };
  }

  preauthorize(session: object, event: MalformedToolAuthorizationRequest): MalformedToolPreauthorization {
    const recoveryAlreadyRequired = this.state.recoveryRequired;
    const decision = decideMalformedToolCorrection(this.state, event.name, event.arguments);
    this.state = decision.next;
    const s = session as any;

    if (decision.action === "PASS_INVALID_WITHOUT_CONSUMING") {
      s.diagnostics?.checkpoint?.("SEMANTIC_TOOL_INVALID_ARGUMENTS_NOT_CONSUMED_V51", {
        tool: event.name || null,
        call_id: event.call_id ?? null,
        semantic_decision_consumed: false,
        business_action_executed: false,
        lower_argument_validation_preserved: true,
        correction_affinity: event.name || null,
        state_owner: "malformed_tool_correction_runtime",
      });
      return "ALLOW_INVALID_WITHOUT_CONSUMING";
    }

    if (decision.action === "REJECT_CROSS_TOOL_CORRECTION") {
      s.diagnostics?.checkpoint?.("SEMANTIC_TOOL_CROSS_TOOL_CORRECTION_BLOCKED_V51", {
        attempted_tool: event.name || null,
        pending_malformed_tool: this.state.pendingMalformedTool,
        same_caller_intervention: true,
        semantic_decision_consumed: false,
        business_action_executed: false,
        recovery_already_required: recoveryAlreadyRequired,
        state_owner: "malformed_tool_correction_runtime",
      });
      const port = realtimeCommandPortFor(session as any);
      port.submitToolResult({
        callId: event.call_id,
        toolName: event.name,
        output: {
          ok: false,
          status: "REJECTED",
          reason: "MALFORMED_TOOL_CORRECTION_MISMATCH",
          expected_tool: this.state.pendingMalformedTool,
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
            authority: "malformed_tool_correction_runtime",
            business_action_executed: "false",
          },
        });
      }
      return "REJECT_CROSS_TOOL_CORRECTION";
    }

    if (decision.action === "PASS_VALID_CORRECTION_TO_V29") {
      this.recoveryResponseId = null;
      s.diagnostics?.checkpoint?.("SEMANTIC_TOOL_VALID_CORRECTION_RELEASED_TO_V29_V51", {
        tool: event.name || null,
        call_id: event.call_id ?? null,
        same_tool_correction: true,
        authority_owner: "semantic_turn_coordinator",
        correction_state_owner: "malformed_tool_correction_runtime",
      });
    }

    return "PASS_TO_SEMANTIC_AUTHORITY";
  }

  observe(session: object, event: RealtimeProviderEvent): void {
    const s = session as any;

    if (
      event.type === "ASSISTANT_RESPONSE_STARTED" &&
      event.purpose === MALFORMED_TOOL_RECOVERY_PURPOSE &&
      event.responseId
    ) {
      this.recoveryResponseId = event.responseId;
      s.diagnostics?.checkpoint?.("SEMANTIC_TOOL_RECOVERY_RESPONSE_BOUND_V51", {
        response_id: event.responseId,
        pending_malformed_tool: this.state.pendingMalformedTool,
        state_owner: "malformed_tool_correction_runtime",
      });
      return;
    }

    if (
      event.type === "ASSISTANT_AUDIO_STOPPED" &&
      this.recoveryResponseId &&
      event.responseId === this.recoveryResponseId
    ) {
      this.state = observeMalformedToolRecoveryPlaybackCompleted(this.state);
      s.diagnostics?.checkpoint?.("SEMANTIC_TOOL_RECOVERY_PLAYBACK_COMPLETED_V51", {
        response_id: event.responseId,
        pending_malformed_tool: this.state.pendingMalformedTool,
        fresh_caller_turn_eligible: this.state.recoveryPlaybackCompleted,
        state_owner: "malformed_tool_correction_runtime",
      });
      this.recoveryResponseId = null;
      return;
    }

    if (event.type === "CALLER_SPEECH_STARTED") {
      const before = this.state.postRecoveryCallerSpeechObserved;
      this.state = observeCallerSpeechAfterMalformedRecovery(this.state);
      if (!before && this.state.postRecoveryCallerSpeechObserved) {
        s.diagnostics?.checkpoint?.("SEMANTIC_TOOL_POST_RECOVERY_CALLER_SPEECH_V51", {
          item_id: event.itemId ?? null,
          pending_malformed_tool: this.state.pendingMalformedTool,
          state_owner: "malformed_tool_correction_runtime",
        });
      }
      return;
    }

    if (event.type === "CALLER_TRANSCRIPT_COMPLETED") {
      const previousTool = this.state.pendingMalformedTool;
      this.state = observeCallerTranscriptAfterMalformedRecovery(this.state);
      if (previousTool && !this.state.pendingMalformedTool) {
        s.diagnostics?.checkpoint?.("SEMANTIC_TOOL_MALFORMED_AFFINITY_RESET_V51", {
          previous_tool: previousTool,
          item_id: event.itemId ?? null,
          authority: "completed_recovery_plus_fresh_caller_speech_and_transcript",
          state_owner: "malformed_tool_correction_runtime",
        });
      }
    }
  }
}

const runtimes = new WeakMap<object, MalformedToolCorrectionRuntime>();

export function malformedToolCorrectionRuntimeFor(session: object): MalformedToolCorrectionRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new MalformedToolCorrectionRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}
