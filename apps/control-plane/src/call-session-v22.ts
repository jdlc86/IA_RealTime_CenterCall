import { CallSession as CallSessionV19 } from "./call-session-v19";
import { HangupController } from "./hangup-controller";
import { deriveMultitableOutput } from "./multitable-reservation-output";
import { hasExplicitZone, normalizeRestaurantLocalIso, RESTAURANT_TIMEZONE } from "./restaurant-datetime";

const BaseConstructor = CallSessionV19 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV19.prototype as any;
const CREATE_RESERVATION = "restaurant_reservation_create";

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
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
 * v22 is now the compatibility composition point above v19.
 *
 * v20 and v21 are no longer in the active inheritance chain: their stable
 * policies live in restaurant-datetime and multitable-reservation-output.
 * Confirmed transport hangup lives in HangupController.
 */
export class CallSession extends BaseConstructor {
  private hangupControllerV22: HangupController | null = null;

  private getHangupControllerV22(): HangupController {
    if (!this.hangupControllerV22) {
      const session = this as any;
      this.hangupControllerV22 = new HangupController({
        getCallId: () => typeof session.callId === "string" && session.callId.trim() ? session.callId : null,
        getSocketConnected: () => session.socket !== null,
        getApiKey: () => session.env?.OPENAI_API_KEY,
        isHangupStarted: () => session.hangupStarted === true,
        setHangupStarted: (value) => { session.hangupStarted = value; },
        clearFinalFarewellWatchdog: () => session.clearFinalFarewellWatchdog?.(),
        resetExternalFlow: () => session.resetExternalFlow?.(),
        diagnostics: session.diagnostics,
      });
    }
    return this.hangupControllerV22;
  }

  private async performHangup(trigger: string): Promise<void> {
    await this.getHangupControllerV22().perform(trigger);
  }

  private sendFunctionOutputV19(callId: string | undefined, output: Record<string, unknown>): void {
    const decision = deriveMultitableOutput(
      output,
      (this as any).multitablePlanV16,
      (this as any).reservationDraftV19,
    );
    if (decision.handled && decision.output) {
      if (decision.diagnosticEvent) {
        (this as any).diagnostics?.checkpoint?.(decision.diagnosticEvent, decision.diagnosticDetails ?? {});
      }
      BasePrototype.sendFunctionOutputV19.call(this, callId, decision.output);
      return;
    }
    BasePrototype.sendFunctionOutputV19.call(this, callId, output);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === CREATE_RESERVATION && event.arguments) {
      try {
        const parsed = JSON.parse(event.arguments) as Record<string, unknown>;
        const rawStartsAt = typeof parsed.starts_at === "string" ? parsed.starts_at.trim() : null;
        if (rawStartsAt && !hasExplicitZone(rawStartsAt)) {
          const normalizedStartsAt = normalizeRestaurantLocalIso(rawStartsAt);
          parsed.starts_at = normalizedStartsAt;
          (this as any).diagnostics?.checkpoint?.("RESERVATION_DATETIME_NORMALIZED_V20", {
            source_timezone: RESTAURANT_TIMEZONE,
            original_starts_at: rawStartsAt,
            normalized_starts_at: normalizedStartsAt,
          });
          const normalizedEvent = { ...event, arguments: JSON.stringify(parsed) };
          await BasePrototype.handleRealtimeMessage.call(this, JSON.stringify(normalizedEvent));
          return;
        }
      } catch (error) {
        (this as any).diagnostics?.fail?.("RESERVATION_DATETIME_NORMALIZATION_FAILED_V20", "RESERVATION_DATETIME_INVALID", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
