import { startSignedFastGeminiIncomingCall, type FastIncomingRuntimeOptions, type FastIncomingRuntimeResult } from "./fast-incoming-runtime";
import type { VerifiedTelnyxIncomingCall } from "./incoming-call";

export type FastGeminiCanaryEnv = Readonly<{
  TELNYX_PUBLIC_KEY: string;
  TELNYX_API_KEY: string;
  GEMINI_ADMISSION_IDENTITY_SECRET: string;
  GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET: string;
  GEMINI_MEDIA_CONTROL_PLANE_TOKEN: string;
  GEMINI_FAST_CANARY_EDGE_URL: string;
  GEMINI_FAST_CANARY_CALLED_NUMBER: string;
  GEMINI_FAST_CANARY_TENANT_ID: string;
  GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION: string;
}>;

type StartIncoming = (
  input: Readonly<{ rawBody: string; signatureBase64: string | null; timestamp: string | null }>,
  options: FastIncomingRuntimeOptions,
) => Promise<FastIncomingRuntimeResult>;

type RouteDependencies = Readonly<{
  startIncoming?: StartIncoming;
  now?: () => number;
}>;

function required(value: unknown, field: string, max = 64_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return digits ? `${hasPlus ? "+" : ""}${digits}` : "";
}

function canaryMatches(call: VerifiedTelnyxIncomingCall, expected: string): boolean {
  return normalizePhone(call.to) === expected;
}

export async function routeFastGeminiCanaryWebhook(
  request: Request,
  env: FastGeminiCanaryEnv,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const rawBody = await request.text();
  if (rawBody.length > 512_000) return new Response("payload too large", { status: 413 });

  const canaryCalledNumber = normalizePhone(required(env.GEMINI_FAST_CANARY_CALLED_NUMBER, "GEMINI_FAST_CANARY_CALLED_NUMBER", 64));
  if (!canaryCalledNumber) throw new Error("GEMINI_FAST_CANARY_CALLED_NUMBER is invalid");
  const tenantId = required(env.GEMINI_FAST_CANARY_TENANT_ID, "GEMINI_FAST_CANARY_TENANT_ID", 256);
  const systemInstruction = required(env.GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION, "GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION", 64_000);
  const startIncoming = dependencies.startIncoming ?? startSignedFastGeminiIncomingCall;
  const now = dependencies.now ?? Date.now;

  const result = await startIncoming({
    rawBody,
    signatureBase64: request.headers.get("telnyx-signature-ed25519"),
    timestamp: request.headers.get("telnyx-timestamp"),
  }, {
    nowEpochMs: now(),
    signatureMaxAgeSeconds: 300,
    admissionTtlMs: 60_000,
    telnyxPublicKey: env.TELNYX_PUBLIC_KEY,
    admissionIdentitySecret: env.GEMINI_ADMISSION_IDENTITY_SECRET,
    mediaCredentialSecret: env.GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET,
    mediaControlToken: env.GEMINI_MEDIA_CONTROL_PLANE_TOKEN,
    telnyxApiKey: env.TELNYX_API_KEY,
    edgeUrl: env.GEMINI_FAST_CANARY_EDGE_URL,
    resolveTenantId: async (call) => canaryMatches(call, canaryCalledNumber) ? tenantId : null,
    isCanaryAllowed: (resolvedTenantId, call) => resolvedTenantId === tenantId && canaryMatches(call, canaryCalledNumber),
    resolveSessionConfig: async () => ({
      systemInstruction,
      tools: [],
      voiceName: "Kore",
      languageCode: "es-ES",
    }),
  });

  switch (result.status) {
    case "SIGNATURE_REJECTED":
      return Response.json({ ok: false, status: result.status }, { status: 401 });
    case "IGNORED_EVENT":
      return new Response(null, { status: 204 });
    case "TENANT_NOT_FOUND":
    case "CANARY_NOT_ALLOWED":
      return Response.json({ ok: false, status: result.status }, { status: 403 });
    case "STARTED":
      return Response.json({ ok: true, status: result.status }, { status: 202 });
  }
}
