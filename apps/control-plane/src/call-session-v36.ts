import { CallSession as CallSessionV35 } from "./call-session-v35";
import { adaptRealtimeProviderEvents } from "./realtime-provider-runtime.js";
import { turnConcurrencyCoordinatorFor } from "./turn-concurrency-coordinator.js";

const BaseConstructor = CallSessionV35 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV35.prototype as any;

/** Compatibility adapter; all shared concurrency state lives in TurnConcurrencyCoordinator. */
export class CallSession extends BaseConstructor {
  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const session = this as any;
    const coordinator = turnConcurrencyCoordinatorFor(this);
    for (const event of adaptRealtimeProviderEvents(data)) {
      if (coordinator.observe(session, event)) return;
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
