function extractE164(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/\+[1-9]\d{7,14}/);
  return match?.[0] ?? null;
}

export function normalizeTrustedCallerNumber(value: string | null | undefined, calledNumber?: string | null): string | null {
  const caller = extractE164(value);
  if (!caller) return null;
  const called = extractE164(calledNumber);
  if (called && caller === called) return null;
  return caller;
}

export function buildTrustedCallerTransferHeaders(
  callerPhone: string,
  tenantId: string,
  calledNumber: string,
  routingSource: string,
  telnyxCallControlId?: string,
): Array<{ name: string; value: string }> {
  return [
    { name: "X-IA-Tenant-ID", value: tenantId },
    { name: "X-IA-Called-Number", value: calledNumber },
    { name: "X-IA-Routing-Source", value: routingSource },
    { name: "X-IA-Caller-Number", value: callerPhone },
    ...(telnyxCallControlId?.trim()
      ? [{ name: "X-IA-Telnyx-Call-Control-ID", value: telnyxCallControlId.trim() }]
      : []),
  ];
}
