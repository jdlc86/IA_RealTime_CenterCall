import { CallSession as CallSessionV11 } from "./call-session-v11";
import { withAuthoritativeTemporalGrounding } from "./temporal-grounding";

const BaseConstructor = CallSessionV11 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV11.prototype as any;

/**
 * v12 centralizes temporal truth at the spoken-response boundary. Upstream
 * workflows provide backend-authorized ISO timestamps; this layer deterministically
 * maps them to Europe/Madrid calendar semantics before the model verbalizes them.
 */
export class CallSession extends BaseConstructor {
  private createSpokenResponse(instructions: string): void {
    const grounded = withAuthoritativeTemporalGrounding(instructions);
    (this as any).diagnostics?.checkpoint?.("TEMPORAL_GROUNDING_APPLIED", {
      applied: grounded !== instructions,
      timezone: "Europe/Madrid",
    });
    BasePrototype.createSpokenResponse.call(this, grounded);
  }
}
