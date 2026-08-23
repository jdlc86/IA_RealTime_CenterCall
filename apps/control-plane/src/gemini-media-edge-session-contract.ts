import type { TelnyxGeminiStreamingStartRequest, TelnyxGeminiStreamingTargetLegs } from "./telnyx-gemini-streaming-port.js";

export type GeminiMediaEdgeSessionBinding = Readonly<{
  provider: "GEMINI";
  tenantId: string;
  callControlId: string;
  edgeUrl: string;
  targetLegs: TelnyxGeminiStreamingTargetLegs;
  notAfterEpochMs: number;
}>;

export type GeminiMediaEdgeSessionSecret = Readonly<{
  streamAuthToken: string;
}>;

export type GeminiMediaEdgeSessionContract = Readonly<{
  binding: GeminiMediaEdgeSessionBinding;
  secret: GeminiMediaEdgeSessionSecret;
}>;

export type GeminiMediaEdgeSessionInput = Readonly<{
  provider: "GEMINI";
  tenantId: string;
  callControlId: string;
  edgeUrl: string;
  streamAuthToken: string;
  targetLegs: TelnyxGeminiStreamingTargetLegs;
  notAfterEpochMs: number;
}>;

export type GeminiMediaEdgeAuditView = Readonly<{
  provider: "GEMINI";
  tenantId: string;
  callControlId: string;
  edgeOrigin: string;
  targetLegs: TelnyxGeminiStreamingTargetLegs;
  notAfterEpochMs: number;
  streamAuth: "PRESENT";
}>;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function secureEdgeUrl(value: unknown, token: string): URL {
  const normalized = required(value, "Gemini media edge URL");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Gemini media edge URL is invalid");
  }
  if (parsed.protocol !== "wss:") throw new Error("Gemini media edge URL must use wss://");
  if (parsed.username || parsed.password) throw new Error("Gemini media edge URL must not contain credentials");
  if (normalized.includes(token) || parsed.href.includes(encodeURIComponent(token))) {
    throw new Error("Gemini media edge token must not be embedded in the URL");
  }
  return parsed;
}

function validExpiry(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Gemini media edge notAfterEpochMs must be a positive safe integer");
  }
  return value;
}

/**
 * Builds the inert, secret-bearing contract passed from the Control Plane to the
 * future Gemini media edge. It performs no admission, token issuance, network I/O,
 * WebSocket creation, Telnyx command or Gemini session start.
 *
 * Token entropy, signature/verification and authoritative expiry are owned by a
 * future credential authority. This boundary only binds an already-issued opaque
 * secret to one trusted tenant/call/provider affinity and prevents URL leakage.
 */
export function createGeminiMediaEdgeSessionContract(input: GeminiMediaEdgeSessionInput): GeminiMediaEdgeSessionContract {
  if (input.provider !== "GEMINI") throw new Error("Gemini media edge provider affinity must be GEMINI");
  const tenantId = required(input.tenantId, "Gemini media edge tenant_id");
  const callControlId = required(input.callControlId, "Gemini media edge call_control_id");
  const streamAuthToken = required(input.streamAuthToken, "Gemini media edge stream auth token");
  if (!(["self", "opposite", "both"] as const).includes(input.targetLegs)) {
    throw new Error("Gemini media edge target legs are invalid");
  }
  const edgeUrl = secureEdgeUrl(input.edgeUrl, streamAuthToken).toString();
  const notAfterEpochMs = validExpiry(input.notAfterEpochMs);

  return Object.freeze({
    binding: Object.freeze({
      provider: "GEMINI" as const,
      tenantId,
      callControlId,
      edgeUrl,
      targetLegs: input.targetLegs,
      notAfterEpochMs,
    }),
    secret: Object.freeze({ streamAuthToken }),
  });
}

/** Safe structured view for logs/telemetry. Never includes the raw stream token. */
export function geminiMediaEdgeAuditView(contract: GeminiMediaEdgeSessionContract): GeminiMediaEdgeAuditView {
  const edge = new URL(contract.binding.edgeUrl);
  return Object.freeze({
    provider: "GEMINI" as const,
    tenantId: contract.binding.tenantId,
    callControlId: contract.binding.callControlId,
    edgeOrigin: edge.origin,
    targetLegs: contract.binding.targetLegs,
    notAfterEpochMs: contract.binding.notAfterEpochMs,
    streamAuth: "PRESENT" as const,
  });
}

/**
 * Pure adapter into the existing Telnyx command port. Calling this function does
 * not execute streaming_start; the caller still owns admission and the side effect.
 */
export function geminiMediaEdgeTelnyxStartRequest(
  contract: GeminiMediaEdgeSessionContract,
  commandId: string,
  clientState?: string,
): TelnyxGeminiStreamingStartRequest {
  return Object.freeze({
    callControlId: contract.binding.callControlId,
    streamUrl: contract.binding.edgeUrl,
    streamAuthToken: contract.secret.streamAuthToken,
    targetLegs: contract.binding.targetLegs,
    commandId: required(commandId, "Gemini media edge streaming command_id"),
    ...(typeof clientState === "string" && clientState.trim() ? { clientState: clientState.trim() } : {}),
  });
}
