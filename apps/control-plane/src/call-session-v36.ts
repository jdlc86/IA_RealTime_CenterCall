import { CallSession as CallSessionV35Runtime } from "./call-session-v35-runtime";
import { turnConcurrencyCoordinatorFor, type TurnConcurrencyEvent } from "./turn-concurrency-coordinator.js";

const BaseConstructor = CallSessionV35Runtime as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV35Runtime.prototype as any;

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function parseEvent(data: unknown): TurnConcurrencyEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as TurnConcurrencyEvent; } catch { return null; }
}

/**
 * Compatibility adapter only. Turn lock, watchdog, playback state and terminal
 * detach are owned by TurnConcurrencyCoordinator.
 */
export class CallSession extends BaseConstructor {
  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const stopPropagation = turnConcurrencyCoordinatorFor(this).observe(this as any, parseEvent(data));
    if (stopPropagation) return;
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
