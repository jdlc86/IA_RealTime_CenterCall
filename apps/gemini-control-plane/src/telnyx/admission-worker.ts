import type { GeminiControlPlaneEnv } from "../gemini-call-session";
import { KvGeminiTenantRoutePort, type TenantRouteKvNamespace } from "../tenant/route";
import { admitSignedTelnyxIncomingCall, type GeminiTelnyxAdmissionRuntimeResult } from "./admission-runtime";

export type GeminiTelnyxAdmissionWorkerEnv = GeminiControlPlaneEnv & Readonly<{
  TENANT_CONFIG: TenantRouteKvNamespace;
  TELNYX_PUBLIC_KEY: string;
  GEMINI_ADMISSION_IDENTITY_SECRET: string;
  GEMINI_CONTROL_CAPABILITY_SECRET: string;
}>;

export type GeminiTelnyxAdmissionWorkerOptions = Readonly<{
  nowEpochMs: number;
  signatureMaxAgeSeconds: number;
  admissionTtlMs: number;
  tenantRouteCacheTtlSeconds?: number;
}>;

/**
 * Internal Worker composition for a Telnyx request. This function is not wired
 * to an HTTP route yet. It preserves the raw request body through signature
 * verification, then resolves only the shared called-number tenant route.
 */
export async function admitTelnyxRequestInternally(
  request: Request,
  env: GeminiTelnyxAdmissionWorkerEnv,
  options: GeminiTelnyxAdmissionWorkerOptions,
): Promise<GeminiTelnyxAdmissionRuntimeResult> {
  if (request.method !== "POST") throw new Error("Telnyx admission requires POST");
  const rawBody = await request.text();
  const tenantRoutes = new KvGeminiTenantRoutePort(
    env.TENANT_CONFIG,
    options.tenantRouteCacheTtlSeconds ?? 30,
  );

  return admitSignedTelnyxIncomingCall(env, {
    rawBody,
    signatureBase64: request.headers.get("telnyx-signature-ed25519"),
    timestamp: request.headers.get("telnyx-timestamp"),
  }, {
    nowEpochMs: options.nowEpochMs,
    signatureMaxAgeSeconds: options.signatureMaxAgeSeconds,
    admissionTtlMs: options.admissionTtlMs,
    telnyxPublicKey: env.TELNYX_PUBLIC_KEY,
    admissionIdentitySecret: env.GEMINI_ADMISSION_IDENTITY_SECRET,
    controlCapabilitySecret: env.GEMINI_CONTROL_CAPABILITY_SECRET,
    resolveTenantId: async (call) => (await tenantRoutes.resolveByCalledNumber(call.calledNumber))?.tenantId ?? null,
  });
}
