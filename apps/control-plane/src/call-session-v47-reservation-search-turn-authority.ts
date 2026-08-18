import { CallSession as CallSessionV46 } from "./call-session-v46-sideband-lifecycle";

const BaseConstructor = CallSessionV46 as unknown as new (...args: any[]) => any;

/**
 * v47 compatibility shell.
 *
 * Reservation-search turn authority no longer lives in this layer. v31 is the
 * compatibility executor for restaurant_reservation_search, but it delegates
 * every public-tool selection to v29's single semantic caller-turn authority
 * before executing the search.
 *
 * Keeping this class temporarily preserves the established v48 -> v47 import
 * chain while removing the duplicate runtime decision state. After E2E confirms
 * that repeated search attempts are rejected by v29 before business execution,
 * this compatibility shell and the retired v47-specific policy can be removed
 * in a separate mechanical cleanup.
 */
export class CallSession extends BaseConstructor {}
