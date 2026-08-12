import { extractE164FromSipIdentity } from "./caller-id";

export function normalizeTrustedCallerNumber(value: string | null | undefined, calledNumber?: string | null): string | null {
  const caller = extractE164FromSipIdentity(value);
  if (!caller) return null;
  const called = extractE164FromSipIdentity(calledNumber);
  if (called && caller === called) return null;
  return caller;
}

export function buildTrustedCallerTransferHeaders(
  callerPhone: string,
  tenantId: string,
  calledNumber: string,
  routingSource: string,
): Array<{ name: string; value: string }> {
  return [
    { name: "X-IA-Tenant-ID", value: tenantId },
    { name: "X-IA-Called-Number", value: calledNumber },
    { name: "X-IA-Routing-Source", value: routingSource },
    { name: "X-IA-Caller-Number", value: callerPhone },
  ];
}
