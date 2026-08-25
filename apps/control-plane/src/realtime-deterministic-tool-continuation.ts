import type { RealtimeToolResultRequest } from "./realtime-provider-command-port.js";

export type RealtimeDeterministicContinuationContext =
  | "GENERAL"
  | "RESERVATION_STARTS_AT_DATE"
  | "RESERVATION_STARTS_AT_TIME"
  | "RESERVATION_PARTY_SIZE"
  | "RESERVATION_CUSTOMER_NAME"
  | "RESERVATION_CUSTOMER_PHONE"
  | "RESERVATION_CONFIRMATION";

export interface RealtimeDeterministicToolContinuationPort {
  bypassDeterministicToolContinuation(
    request: RealtimeToolResultRequest,
    context: RealtimeDeterministicContinuationContext,
  ): void;
}

export function deterministicToolContinuationPort(
  value: RealtimeProviderCommandPortLike,
): RealtimeDeterministicToolContinuationPort | null {
  const candidate = value as RealtimeProviderCommandPortLike & Partial<RealtimeDeterministicToolContinuationPort>;
  return typeof candidate.bypassDeterministicToolContinuation === "function"
    ? candidate as RealtimeDeterministicToolContinuationPort
    : null;
}

type RealtimeProviderCommandPortLike = object;
