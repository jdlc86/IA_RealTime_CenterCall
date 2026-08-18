import type { LifecycleEvent } from "./conversation-turn-lifecycle";

type TransportClosedLifecycleEvent = Extract<LifecycleEvent, { type: "transport_closed" }>;

/**
 * The transport layer observes sideband closure but does not own conversation
 * timers or presence state. It translates the transport fact into a lifecycle
 * event; ConversationTurnLifecycle remains the sole authority for deciding how
 * realtime-dependent conversation state becomes inert.
 */
export function sidebandCloseLifecycleEvent(reason: string): TransportClosedLifecycleEvent {
  return { type: "transport_closed", reason };
}
