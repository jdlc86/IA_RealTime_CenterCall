import { CallSession as CallSessionV41 } from "./call-session-v41-closure-guard";
import {
  beginUserTurn,
  initialHandoffTurnPolicyState,
  markResolvedResponseCompleted,
  recordSelfServiceResult,
  shouldBlockHumanHandoff,
  type HandoffTurnPolicyState,
} from "./human-handoff-turn-policy.js";
import { shouldRearmPresenceAfterTrigger } from "./presence-rearm-policy.js";

const BaseConstructor = CallSessionV41 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV41.prototype as any;
const HUMAN_ASSISTANCE = "restaurant_human_assistance";

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  transcript?: unknown;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function parseEvent(data: unknown): RealtimeEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as RealtimeEvent; } catch { return null; }
}

function usableTranscript(value: unknown): boolean {
  return typeof value === "string" && value.replace(/\s+/g, " ").trim().length > 0;
}

function parseToolOutput(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * v42 closes two turn-boundary holes observed in production diagnostics:
 *
 * 1. Background/ignored audio is neutral evidence. It must not restart the
 *    inactivity window. The existing waiting deadline continues unchanged.
 *
 * 2. Human handoff is irreversible. If the current caller turn was already
 *    conclusively answered by restaurant_business_info (FOUND) and the answer
 *    completed, a model-selected handoff in that same turn is rejected. A new
 *    caller transcript clears the guard immediately.
 */
export class CallSession extends BaseConstructor {
  private handoffTurnStateV42: HandoffTurnPolicyState = initialHandoffTurnPolicyState();
  private toolByCallIdV42 = new Map<string, string>();
  private sendWrappedV42 = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok) this.installSendBoundaryV42();
    return response;
  }

  private armWaitingForUserV18(trigger: string): void {
    if (!shouldRearmPresenceAfterTrigger(trigger)) {
      (this as any).toolExecutionActiveV18 = false;
      (this as any).diagnostics?.checkpoint?.("BACKGROUND_INPUT_DID_NOT_REARM_PRESENCE_V42", {
        trigger,
        inactivity_deadline_preserved: true,
      });
      return;
    }
    BasePrototype.armWaitingForUserV18?.call(this, trigger);
  }

  private installSendBoundaryV42(): void {
    if (this.sendWrappedV42) return;
    const session = this as any;
    if (typeof session.send !== "function") return;
    const previousSend = session.send.bind(this);
    this.sendWrappedV42 = true;

    session.send = (message: any) => {
      if (message?.type === "conversation.item.create" && message?.item?.type === "function_call_output") {
        const callId = typeof message.item.call_id === "string" ? message.item.call_id : "";
        const tool = callId ? this.toolByCallIdV42.get(callId) : undefined;
        const output = parseToolOutput(message.item.output);
        const status = typeof output?.status === "string" ? output.status : "";
        if (tool && status) {
          this.handoffTurnStateV42 = recordSelfServiceResult(this.handoffTurnStateV42, tool, status);
          if (tool === "restaurant_business_info" && status === "FOUND") {
            session.diagnostics?.checkpoint?.("SELF_SERVICE_TURN_RESOLVED_V42", {
              tool,
              status,
              turn_id: this.handoffTurnStateV42.turnId,
            });
          }
        }
      }
      previousSend(message);
    };
  }

  private rejectRedundantHandoffV42(event: RealtimeEvent): void {
    const session = this as any;
    session.releaseSemanticGateV29?.(HUMAN_ASSISTANCE);
    session.send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify({
          ok: true,
          status: "HANDOFF_NOT_NEEDED_CURRENT_TURN_RESOLVED",
          transfer_started: false,
          instruction: "No transfieras. La petición del turno actual ya fue resuelta con información oficial del restaurante. Espera el siguiente turno del usuario.",
        }),
      },
    });
    session.diagnostics?.checkpoint?.("HUMAN_HANDOFF_BLOCKED_RESOLVED_TURN_V42", {
      turn_id: this.handoffTurnStateV42.turnId,
      resolved_tool: this.handoffTurnStateV42.resolvedTool,
      resolved_status: this.handoffTurnStateV42.resolvedStatus,
      irreversible_transfer_prevented: true,
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);

    if (event?.type === "conversation.item.input_audio_transcription.completed" && usableTranscript(event.transcript)) {
      this.handoffTurnStateV42 = beginUserTurn(this.handoffTurnStateV42);
    }

    if (event?.type === "response.function_call_arguments.done" && event.call_id && event.name) {
      this.toolByCallIdV42.set(event.call_id, event.name);
      if (event.name === HUMAN_ASSISTANCE && shouldBlockHumanHandoff(this.handoffTurnStateV42)) {
        this.rejectRedundantHandoffV42(event);
        return;
      }
    }

    if (event?.type === "response.done") {
      this.handoffTurnStateV42 = markResolvedResponseCompleted(this.handoffTurnStateV42);
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
