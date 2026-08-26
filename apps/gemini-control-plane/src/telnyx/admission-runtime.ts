import { issueGeminiAdmissionIdentity } from "../admission/identity-issuer";
import { registerGeminiAdmission, type RegisterGeminiAdmissionResult } from "../admission/runtime";
import { GEMINI_ADMISSION_VERSION_V1 } from "../admission/v1";
import {
  GEMINI_CONTROL_CAPABILITY_VERSION_V1,
  issueGeminiControlCapabilityV1,
} from "../control-auth/capability-v1";
import {
  buildGeminiEdgeControlBootstrapV1,
  type GeminiEdgeControlBootstrapV1,
} from "../edge-control/bootstrap-v1";
import type { GeminiControlPlaneEnv } from "../gemini-call-session";
import { parseVerifiedTelnyxIncomingCall, type VerifiedTelnyxIncomingCall } from "./incoming-call";
import { verifyTelnyxWebhookSignature } from "./webhook-signature";

export type GeminiTelnyxAdmissionRuntimeOptions = Readonly<{
  nowEpochMs: number;
  signatureMaxAgeSeconds: number;
  admissionTtlMs: number;
  telnyxPublicKey: string;
  admissionIdentitySecret: string;
  controlCapabilitySecret: string;
  controlUrl: string;
  resolveTenantId: (call: VerifiedTelnyxIncomingCall) => Promise<string | null>;
}>;

export type GeminiTelnyxAdmissionRuntimeResult =
  | Readonly<{ status: "SIGNATURE_REJECTED" }>
  | Readonly<{ status: "TENANT_NOT_FOUND"; call: VerifiedTelnyxIncomingCall }>
  | Readonly<{
      status: "ADMITTED";
      call: VerifiedTelnyxIncomingCall;
      result: RegisterGeminiAdmissionResult;
      edgeControlBootstrap: GeminiEdgeControlBootstrapV1;
    }>;

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

export async function admitSignedTelnyxIncomingCall(
  env: GeminiControlPlaneEnv,
  input: Readonly<{
    rawBody: string;
    signatureBase64: string | null;
    timestamp: string | null;
  }>,
  options: GeminiTelnyxAdmissionRuntimeOptions,
): Promise<GeminiTelnyxAdmissionRuntimeResult> {
  const nowEpochMs = positiveSafeInteger(options.nowEpochMs, "Gemini Telnyx admission nowEpochMs");
  const signatureMaxAgeSeconds = positiveSafeInteger(options.signatureMaxAgeSeconds, "Gemini Telnyx signature max age");
  const admissionTtlMs = positiveSafeInteger(options.admissionTtlMs, "Gemini admission TTL");

  const signatureValid = await verifyTelnyxWebhookSignature({
    rawBody: input.rawBody,
    signatureBase64: input.signatureBase64,
    timestamp: input.timestamp,
    publicKey: options.telnyxPublicKey,
    nowEpochMs,
    maxAgeSeconds: signatureMaxAgeSeconds,
  });
  if (!signatureValid) return Object.freeze({ status: "SIGNATURE_REJECTED" });

  const call = parseVerifiedTelnyxIncomingCall(input.rawBody);
  const tenantId = await options.resolveTenantId(call);
  if (!tenantId) return Object.freeze({ status: "TENANT_NOT_FOUND", call });

  const ids = await issueGeminiAdmissionIdentity({
    tenantId,
    telnyxEventId: call.eventId,
    callControlId: call.callControlId,
    secret: options.admissionIdentitySecret,
  });
  const notAfterEpochMs = call.occurredAtEpochMs + admissionTtlMs;
  if (!Number.isSafeInteger(notAfterEpochMs) || notAfterEpochMs <= nowEpochMs) {
    throw new Error("Gemini admission derived expiry is not valid for a live admission");
  }

  const result = await registerGeminiAdmission(env, {
    version: GEMINI_ADMISSION_VERSION_V1,
    provider: "GEMINI",
    tenantId,
    callControlId: call.callControlId,
    callSessionId: ids.callSessionId,
    edgeSessionId: ids.edgeSessionId,
    credentialId: ids.credentialId,
    notAfterEpochMs,
  }, {
    nowEpochMs,
    maxTtlMs: admissionTtlMs,
  });

  const admission = result.admission;
  const controlCapability = await issueGeminiControlCapabilityV1({
    version: GEMINI_CONTROL_CAPABILITY_VERSION_V1,
    provider: "GEMINI",
    tenantId: admission.tenantId,
    callControlId: admission.callControlId,
    callSessionId: admission.callSessionId,
    edgeSessionId: admission.edgeSessionId,
    credentialId: admission.credentialId,
    notAfterEpochMs: admission.notAfterEpochMs,
  }, options.controlCapabilitySecret);

  const edgeControlBootstrap = buildGeminiEdgeControlBootstrapV1(admission, {
    controlUrl: options.controlUrl,
    controlCapability,
    nowEpochMs,
  });

  return Object.freeze({ status: "ADMITTED", call, result, edgeControlBootstrap });
}
