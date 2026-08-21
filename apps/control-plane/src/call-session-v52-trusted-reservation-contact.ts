import { CallSession as CallSessionV51 } from "./call-session-v51-malformed-tool-authority";

const BaseConstructor = CallSessionV51 as unknown as new (...args: any[]) => any;

/**
 * V52 remains as the active chain compatibility generation.
 * Reservation contact identity is now owned by ReservationContactIdentityRuntime
 * at the provider-neutral reservation controller boundary in V19, so this layer
 * no longer parses or reconstructs realtime provider events.
 */
export class CallSession extends BaseConstructor {}
