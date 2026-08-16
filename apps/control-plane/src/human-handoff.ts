export type HumanHandoffConfig = {
  enabled: boolean;
  destination: {
    type: "PHONE";
    phone: string;
    label: string;
  };
  transfer: {
    mode: "BLIND";
    answerTimeoutSeconds: number;
  };
  failurePolicy: {
    action: "TERMINATE_AND_CALLBACK";
    message: string;
  };
  successMessage: string;
};

export type HumanHandoffClientState = {
  kind: "human_handoff_v1";
  handoffId: string;
  realtimeCallId: string;
  tenantId: string;
  sourceCallControlId: string;
};

export type HandoffFailureStatus = "NO_ANSWER" | "BUSY" | "FAILED";

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid tenant configuration: ${field}`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid tenant configuration: ${field}`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`Invalid tenant configuration: ${field} is too long`);
  return trimmed;
}

function requireE164(value: unknown, field: string): string {
  const phone = requireString(value, field, 32);
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error(`Invalid tenant configuration: ${field} must be E.164`);
  return phone;
}

export function parseHumanHandoffConfig(raw: unknown): HumanHandoffConfig | undefined {
  if (raw === undefined) return undefined;
  const record = requireObject(raw, "humanHandoff");
  if (typeof record.enabled !== "boolean") throw new Error("Invalid tenant configuration: humanHandoff.enabled");

  const destination = requireObject(record.destination, "humanHandoff.destination");
  const transfer = requireObject(record.transfer, "humanHandoff.transfer");
  const failure = requireObject(record.failurePolicy, "humanHandoff.failurePolicy");

  if (destination.type !== "PHONE") throw new Error("Invalid tenant configuration: humanHandoff.destination.type");
  if (transfer.mode !== "BLIND") throw new Error("Invalid tenant configuration: humanHandoff.transfer.mode");
  if (failure.action !== "TERMINATE_AND_CALLBACK") throw new Error("Invalid tenant configuration: humanHandoff.failurePolicy.action");

  const timeout = transfer.answerTimeoutSeconds;
  if (!Number.isInteger(timeout) || (timeout as number) < 5 || (timeout as number) > 120) {
    throw new Error("Invalid tenant configuration: humanHandoff.transfer.answerTimeoutSeconds");
  }

  return {
    enabled: record.enabled,
    destination: {
      type: "PHONE",
      phone: requireE164(destination.phone, "humanHandoff.destination.phone"),
      label: requireString(destination.label, "humanHandoff.destination.label", 100),
    },
    transfer: { mode: "BLIND", answerTimeoutSeconds: timeout as number },
    failurePolicy: {
      action: "TERMINATE_AND_CALLBACK",
      message: requireString(failure.message, "humanHandoff.failurePolicy.message", 500),
    },
    successMessage: requireString(record.successMessage, "humanHandoff.successMessage", 500),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeHumanHandoffClientState(state: HumanHandoffClientState): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(state)));
}

export function decodeHumanHandoffClientState(value: unknown): HumanHandoffClientState | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(value.trim()))) as Record<string, unknown>;
    if (parsed.kind !== "human_handoff_v1") return null;
    for (const field of ["handoffId", "realtimeCallId", "tenantId", "sourceCallControlId"] as const) {
      if (typeof parsed[field] !== "string" || !(parsed[field] as string).trim()) return null;
    }
    return {
      kind: "human_handoff_v1",
      handoffId: (parsed.handoffId as string).trim(),
      realtimeCallId: (parsed.realtimeCallId as string).trim(),
      tenantId: (parsed.tenantId as string).trim(),
      sourceCallControlId: (parsed.sourceCallControlId as string).trim(),
    };
  } catch {
    return null;
  }
}

export function classifyHandoffFailure(hangupCause: unknown): HandoffFailureStatus {
  const cause = typeof hangupCause === "string" ? hangupCause.trim().toLowerCase() : "";
  if (cause === "timeout" || cause === "no_answer" || cause === "no-answer") return "NO_ANSWER";
  if (cause.includes("busy")) return "BUSY";
  return "FAILED";
}
