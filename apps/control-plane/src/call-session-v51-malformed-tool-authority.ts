import { CallSession as CallSessionV50 } from "./call-session-v50-reservation-date-scope";
import { malformedToolCorrectionRuntimeFor } from "./malformed-tool-correction-runtime.js";
import { adaptRealtimeProviderEvents } from "./realtime-provider-runtime.js";

const BaseConstructor = CallSessionV50 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV50.prototype as any;

/**
 * V51 is the provider-event adapter for malformed-tool recovery lifecycle.
 * Correction affinity, preauthorization and recovery response correlation are
 * owned by MalformedToolCorrectionRuntime and consumed through the neutral
 * semantic-tool authorization port.
 */
export class CallSession extends BaseConstructor {
  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const runtime = malformedToolCorrectionRuntimeFor(this);
    for (const event of adaptRealtimeProviderEvents(data)) runtime.observe(this, event);
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
