import {
  type CallerSecuritySignal,
  type QueuedCallerSecuritySignal,
  type SecuritySignalDecision,
} from "./caller-security.js";
import { callerSecurityPortFor } from "./caller-security-port.js";

type SecuritySignalHost = object & {
  env?: { CALLER_SECURITY_SIGNALS?: Queue<QueuedCallerSecuritySignal> };
};

export type SecuritySignalDelivery =
  | { delivery: "DIRECT"; decision: SecuritySignalDecision }
  | { delivery: "QUEUED"; decision: null };

/**
 * Persists once when Supabase is healthy and falls back to an at-least-once
 * queue using the same event key. The queue contains no phone or transcript.
 */
export async function recordCallerSecuritySignalDurably(
  host: SecuritySignalHost,
  signal: Omit<CallerSecuritySignal, "eventKey"> & { eventKey?: string; callerPhone: string },
): Promise<SecuritySignalDelivery> {
  const eventKey = typeof signal.eventKey === "string" && signal.eventKey.trim()
    ? signal.eventKey.trim()
    : crypto.randomUUID();
  const port = callerSecurityPortFor(host);
  const callerKey = await port.callerKey(signal.tenantId, signal.callerPhone);
  const queuedSignal: QueuedCallerSecuritySignal = {
    eventKey,
    tenantId: signal.tenantId,
    callerKey,
    eventType: signal.eventType,
    severity: signal.severity,
    riskDelta: signal.riskDelta,
    highConfidence: signal.highConfidence,
    metadata: signal.metadata,
  };

  try {
    const decision = await port.recordSignalByCallerKey(queuedSignal);
    return { delivery: "DIRECT", decision };
  } catch (directError) {
    const queue = host.env?.CALLER_SECURITY_SIGNALS;
    if (!queue || typeof queue.send !== "function") throw directError;
    await queue.send(queuedSignal, { contentType: "json" });
    return { delivery: "QUEUED", decision: null };
  }
}
