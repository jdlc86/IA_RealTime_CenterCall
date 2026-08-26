import type { GeminiAdmissionV1 } from "../admission/v1";

export const GEMINI_EDGE_CONTROL_BOOTSTRAP_VERSION_V1 = "gemini-edge-control-bootstrap.v1" as const;

export type GeminiEdgeControlBootstrapV1 = Readonly<{
  version: typeof GEMINI_EDGE_CONTROL_BOOTSTRAP_VERSION_V1;
  provider: "GEMINI";
  tenantId: string;
  callControlId: string;
  callSessionId: string;
  edgeSessionId: string;
  credentialId: string;
  controlUrl: string;
  controlCapability: string;
  notAfterEpochMs: number;
}>;

function required(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\r\n\t]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function controlWssUrl(value: unknown): string {
  const raw = required(value, "Gemini edge control URL", 2048);
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("Gemini edge control URL is invalid"); }
  if (url.protocol !== "wss:") throw new Error("Gemini edge control URL must use wss://");
  if (url.username || url.password) throw new Error("Gemini edge control URL must not contain user info");
  if (url.search) throw new Error("Gemini edge control URL must not contain query identity");
  if (url.hash) throw new Error("Gemini edge control URL must not contain a fragment");
  if (url.pathname !== "/internal/control") throw new Error("Gemini edge control URL path is invalid");
  return url.toString();
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

export function buildGeminiEdgeControlBootstrapV1(
  admission: GeminiAdmissionV1,
  input: Readonly<{
    controlUrl: string;
    controlCapability: string;
    nowEpochMs: number;
  }>,
): GeminiEdgeControlBootstrapV1 {
  if (admission.version !== "gemini-admission.v1" || admission.provider !== "GEMINI") {
    throw new Error("Gemini edge control bootstrap requires a Gemini admission v1");
  }
  const nowEpochMs = positiveSafeInteger(input.nowEpochMs, "Gemini edge control bootstrap nowEpochMs");
  const notAfterEpochMs = positiveSafeInteger(admission.notAfterEpochMs, "Gemini edge control bootstrap notAfterEpochMs");
  if (notAfterEpochMs <= nowEpochMs) throw new Error("Gemini edge control bootstrap is expired");

  return Object.freeze({
    version: GEMINI_EDGE_CONTROL_BOOTSTRAP_VERSION_V1,
    provider: "GEMINI",
    tenantId: required(admission.tenantId, "Gemini edge control bootstrap tenantId"),
    callControlId: required(admission.callControlId, "Gemini edge control bootstrap callControlId"),
    callSessionId: required(admission.callSessionId, "Gemini edge control bootstrap callSessionId"),
    edgeSessionId: required(admission.edgeSessionId, "Gemini edge control bootstrap edgeSessionId"),
    credentialId: required(admission.credentialId, "Gemini edge control bootstrap credentialId"),
    controlUrl: controlWssUrl(input.controlUrl),
    controlCapability: required(input.controlCapability, "Gemini edge control capability", 8192),
    notAfterEpochMs,
  });
}

export function publicGeminiEdgeControlBootstrapAuditV1(value: GeminiEdgeControlBootstrapV1) {
  return Object.freeze({
    version: value.version,
    provider: value.provider,
    tenantId: value.tenantId,
    callControlId: value.callControlId,
    callSessionId: value.callSessionId,
    edgeSessionId: value.edgeSessionId,
    credentialId: value.credentialId,
    controlUrl: value.controlUrl,
    notAfterEpochMs: value.notAfterEpochMs,
    controlCapabilityPresent: Boolean(value.controlCapability),
  });
}
