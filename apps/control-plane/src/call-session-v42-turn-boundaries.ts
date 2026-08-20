import { CallSession as CallSessionV41 } from "./call-session-v41-closure-guard";
import {
  beginUserTurn,
  initialHandoffTurnPolicyState,
  markResolvedResponseCompleted,
  recordSelfServiceResult,
  shouldBlockHumanHandoff,
  type HandoffTurnPolicyState,
} from "./human-handoff-turn-policy.js";
import {
  adaptRealtimeProviderEvents,
  installRealtimeToolResultObserver,
  realtimeCommandPortFor,
} from "./realtime-provider-runtime.js";
import { releaseSemanticGate } from "./semantic-turn-coordinator.js";

const BaseConstructor = CallSessionV41 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV41.prototype as any;
const HUMAN_ASSISTANCE = "restaurant_human_assistance";

function usableTranscript(value: unknown): boolean {
  return typeof value === "string" && value.replace(/\s+/g, " ").trim().length > 0;
}

function toolResultStatus(output: unknown): string {
  if (!output || typeof output !== "object" || Array.isArray(output)) return "";
  const status = (output as Record<string, unknown>).status;
  return typeof status === "string" ? status : "";
}

/**
 * v42 owns only the same-turn self-service/handoff boundary.
 * Provider wire format and tool-result observation are delegated to the neutral
 * realtime runtime. If restaurant_business_info resolves the current turn with
 * FOUND and the answer completes, a model-selected handoff in that same turn is
 * rejected. A new usable caller transcript opens a fresh turn and clears this guard.
 */
export class CallSession extends BaseConstructor {
  private handoffTurnStateV42: HandoffTurnPolicyState = initialHandoffTurnPolicyState();
  private toolByCallIdV42 = new Map<string, string>();
  private toolResultObserverInstalledV42 = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok) this.installToolResultObserverV42();
    return response;
  }

  private installToolResultObserverV42(): void {
    if (this.toolResultObserverInstalledV42) return;
    this.toolResultObserverInstalledV42 = true;
    installRealtimeToolResultObserver(this as any, (request) => {
      const mappedTool = request.callId ? this.toolByCallIdV42.get(request.callId) : undefined;
      if (request.callId && mappedTool) this.toolByCallIdV42.delete(request.callId);
      const tool = request.toolName ?? mappedTool;
      const status = toolResultStatus(request.output);
      if (!tool || !status) return;

      this.handoffTurnStateV42 = recordSelfServiceResult(this.handoffTurnStateV42, tool, status);
      if (tool === "restaurant_business_info" && status === "FOUND") {
        (this as any).diagnostics?.checkpoint?.("SELF_SERVICE_TURN_RESOLVED_V42", {
          tool,
          status,
          turn_id: this.handoffTurnStateV42.turnId,
          tool_result_owner: "realtime_provider_runtime",
        });
      }
    });
  }

  private rejectRedundantHandoffV42(callId: string | undefined): void {
    const session = this as any;
    releaseSemanticGate(this, HUMAN_ASSISTANCE);
    realtimeCommandPortFor(session).submitToolResult({
      callId,
      toolName: HUMAN_ASSISTANCE,
      output: {
        ok: true,
        status: "HANDOFF_NOT_NEEDED_CURRENT_TURN_RESOLVED",
        transfer_started: false,
        instruction: "No transfieras. La petición del turno actual ya fue resuelta con información oficial del restaurante. Espera el siguiente turno del usuario.",
      },
    });
    session.diagnostics?.checkpoint?.("HUMAN_HANDOFF_BLOCKED_RESOLVED_TURN_V42", {
      turn_id: this.handoffTurnStateV42.turnId,
      resolved_tool: this.handoffTurnStateV42.resolvedTool,
      resolved_status: this.handoffTurnStateV42.resolvedStatus,
      irreversible_transfer_prevented: true,
      semantic_gate_owner: "semantic_turn_coordinator",
      provider_command_port: true,
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const events = adaptRealtimeProviderEvents(data);

    for (const event of events) {
      if (event.type === "CALLER_TRANSCRIPT_COMPLETED" && usableTranscript(event.transcript)) {
        this.handoffTurnStateV42 = beginUserTurn(this.handoffTurnStateV42);
      }

      if (event.type === "SEMANTIC_TOOL_SELECTED") {
        if (event.callId) this.toolByCallIdV42.set(event.callId, event.name);
        if (event.name === HUMAN_ASSISTANCE && shouldBlockHumanHandoff(this.handoffTurnStateV42)) {
          this.rejectRedundantHandoffV42(event.callId);
          return;
        }
      }

      if (event.type === "ASSISTANT_RESPONSE_COMPLETED") {
        this.handoffTurnStateV42 = markResolvedResponseCompleted(this.handoffTurnStateV42);
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
