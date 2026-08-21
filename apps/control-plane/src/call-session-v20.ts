import { CallSession as CallSessionV19 } from "./call-session-v19";

const BaseConstructor = CallSessionV19 as unknown as new (...args: any[]) => any;

/**
 * Compatibility layer retained for chain stability. Reservation datetime
 * normalization and validity are owned by ReservationDatetimeRuntime and are
 * invoked by the provider-neutral V19 reservation controller before draft merge.
 */
export class CallSession extends BaseConstructor {}
