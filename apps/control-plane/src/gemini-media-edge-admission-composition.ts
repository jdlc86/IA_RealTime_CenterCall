import { requireInboundRealtimeRouteReady } from "./inbound-realtime-route.js";
import {
  createGeminiMediaEdgeSessionContract,
  type GeminiMediaEdgeSessionBinding,
  type GeminiMediaEdgeSessionContract,
} from "./gemini-media-edge-session-contract.js";
import type { RealtimeProviderSelection } from "./realtime-provider-selector.js";
import type { TelnyxGeminiStreamingTargetLegs } from "./telnyx-gemini-streaming-port.js";

export type GeminiMediaEdgeProvisioningInput = Readonly<{
  callControlId: string;
  edgeUrl: string;
  targetLegs: TelnyxGeminiStreamingTargetLegs;
  notAfterEpochMs: number;
}>;

export type GeminiMediaEdgeCredentialClaims = GeminiMediaEdgeSessionBinding;

export type GeminiMediaEdgeCredentialIssuer = (
  claims: GeminiMediaEdgeCredentialClaims,
) => Promise<Readonly<{ streamAuthToken: string }>> | Readonly<{ streamAuthToken: string }>;

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function provisionalClaims(
  selection: RealtimeProviderSelection,
  input: GeminiMediaEdgeProvisioningInput,
): GeminiMediaEdgeCredentialClaims {
  if (selection.provider !== "GEMINI") {
    throw new Error(`Gemini media edge provisioning requires GEMINI affinity, got ${selection.provider}`);
  }
  const callControlId = required(input.callControlId, "Gemini media edge call_control_id");
  const tenantId = required(selection.tenantId, "Gemini media edge tenant_id");
  if (!(["self", "opposite", "both"] as const).includes(input.targetLegs)) {
    throw new Error("Gemini media edge target legs are invalid");
  }
  if (typeof input.notAfterEpochMs !== "number" || !Number.isSafeInteger(input.notAfterEpochMs) || input.notAfterEpochMs <= 0) {
    throw new Error("Gemini media edge notAfterEpochMs must be a positive safe integer");
  }
  let edge: URL;
  try {
    edge = new URL(required(input.edgeUrl, "Gemini media edge URL"));
  } catch {
    throw new Error("Gemini media edge URL is invalid");
  }
  if (edge.protocol !== "wss:") throw new Error("Gemini media edge URL must use wss://");
  if (edge.username || edge.password) throw new Error("Gemini media edge URL must not contain credentials");

  return Object.freeze({
    provider: "GEMINI" as const,
    tenantId,
    callControlId,
    edgeUrl: edge.toString(),
    targetLegs: input.targetLegs,
    notAfterEpochMs: input.notAfterEpochMs,
  });
}

/**
 * Production-safe provisioning boundary for a future Gemini call.
 *
 * Traffic admission is evaluated before credential issuance. Because credential
 * issuers may persist state or mint an externally usable capability, invoking an
 * issuer is itself considered a provider-side effect. Gemini currently fails this
 * admission boundary and therefore the issuer must remain untouched.
 *
 * This function does not execute Telnyx streaming_start or open any WebSocket.
 */
export async function requireGeminiMediaEdgeProvisioningReady(
  selection: RealtimeProviderSelection,
  input: GeminiMediaEdgeProvisioningInput,
  issueCredential: GeminiMediaEdgeCredentialIssuer,
): Promise<GeminiMediaEdgeSessionContract> {
  const route = requireInboundRealtimeRouteReady(selection);
  if (route.provider !== "GEMINI" || route.transport !== "GEMINI_MEDIA_BRIDGE") {
    throw new Error(`Gemini media edge provisioning requires GEMINI_MEDIA_BRIDGE, got ${route.provider}/${route.transport}`);
  }

  const claims = provisionalClaims(selection, input);
  const credential = await issueCredential(claims);
  const streamAuthToken = required(credential?.streamAuthToken, "Gemini media edge issued stream auth token");

  return createGeminiMediaEdgeSessionContract({
    ...claims,
    streamAuthToken,
  });
}
