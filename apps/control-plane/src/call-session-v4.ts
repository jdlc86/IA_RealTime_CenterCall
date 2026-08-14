import { CallSession as CallSessionV3 } from "./call-session-v3";
import type { ReservationFlowArgs } from "./reservation-flow";

const MANAGE_RESERVATION = "manage_reservation";

const BaseConstructor = CallSessionV3 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV3.prototype as any;

type RealtimeOutputItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

type RealtimeTruthEvent = {
  type?: string;
  response?: {
    output?: RealtimeOutputItem[];
  };
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

/**
 * v4 no interprets assistant speech. Business truth comes only from structured
 * backend evidence. This layer keeps two mechanical responsibilities:
 *  - remember that CREATE actually returned BOOKED;
 *  - recover a manage_reservation function call when Realtime omitted the
 *    function_call_arguments.done event but included it in response.done.
 */
export class CallSession extends BaseConstructor {
  private reservationBookedThisCall = false;
  private recoveredFunctionCallIds = new Set<string>();

  private async executeReservationFlow(args: ReservationFlowArgs, tenantId: string): Promise<Record<string, unknown>> {
    const result = await BasePrototype.executeReservationFlow.call(this, args, tenantId) as Record<string, unknown>;
    if (result?.stage === "BOOKED") {
      this.reservationBookedThisCall = true;
      (this as any).diagnostics?.checkpoint?.("RESERVATION_BOOKED_EVIDENCE", {
        source: "authorized_backend_result",
        evidence_model: "structured_backend_v2",
      });
    }
    return result;
  }

  private recoverFunctionCallFromResponseDone(event: RealtimeTruthEvent): RealtimeOutputItem | null {
    const output = event.response?.output;
    if (!Array.isArray(output)) return null;
    const item = output.find((candidate) =>
      candidate?.type === "function_call" &&
      candidate.name === MANAGE_RESERVATION &&
      typeof candidate.call_id === "string" &&
      typeof candidate.arguments === "string"
    );
    if (!item?.call_id || !item.arguments) return null;
    if (this.recoveredFunctionCallIds.has(item.call_id)) return null;
    return item;
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeTruthEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeTruthEvent; } catch { event = null; }
    }

    if (event?.type === "response.done") {
      const recovered = this.recoverFunctionCallFromResponseDone(event);
      if (recovered?.call_id && recovered.arguments) {
        this.recoveredFunctionCallIds.add(recovered.call_id);
        (this as any).diagnostics?.recovered?.("FUNCTION_CALL_RECOVERED_FROM_RESPONSE_DONE", "function_call_arguments_done_event_missing", {
          tool: MANAGE_RESERVATION,
        });
        const synthetic = JSON.stringify({
          type: "response.function_call_arguments.done",
          name: MANAGE_RESERVATION,
          call_id: recovered.call_id,
          arguments: recovered.arguments,
        });
        await BasePrototype.handleRealtimeMessage.call(this, synthetic);
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
