import { startSignedFastGeminiIncomingCall, type FastIncomingRuntimeOptions, type FastIncomingRuntimeResult, type FastTenantRoute } from "./fast-incoming-runtime";

type TenantRoutingKv = Readonly<{
  get(key: string): Promise<string | null>;
}>;

export type FastGeminiCanaryEnv = Readonly<{
  TELNYX_PUBLIC_KEY: string;
  TELNYX_API_KEY: string;
  GEMINI_ADMISSION_IDENTITY_SECRET: string;
  GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET: string;
  GEMINI_MEDIA_CONTROL_PLANE_TOKEN: string;
  GEMINI_FAST_CANARY_EDGE_URL: string;
  GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION: string;
  TENANT_ROUTING_KV: TenantRoutingKv;
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

function canonicalE164(value: string): string {
  const normalized = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error("Called number must be E.164");
  return normalized;
}

function canonicalTenantRoute(value: unknown): FastTenantRoute | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.enabled !== true) return null;
  const tenantId = required(record.tenant_id, "KV tenant_id", 256);
  const routeId = record.route_id == null ? "default" : required(record.route_id, "KV route_id", 256);
  return Object.freeze({ tenantId, routeId });
}

async function resolveTenantRouteFromKv(kv: TenantRoutingKv, calledNumber: string): Promise<FastTenantRoute | null> {
  const e164 = canonicalE164(calledNumber);
  const raw = await kv.get(`tenant_by_phone:${e164}`);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Tenant routing KV value is invalid JSON"); }
  return canonicalTenantRoute(parsed);
}

export async function routeFastGeminiCanaryWebhook(
  request: Request,
  env: FastGeminiCanaryEnv,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const rawBody = await request.text();
  if (rawBody.length > 512_000) return new Response("payload too large", { status: 413 });

  if (!env.TENANT_ROUTING_KV || typeof env.TENANT_ROUTING_KV.get !== "function") {
    throw new Error("TENANT_ROUTING_KV binding is required");
  }

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
    resolveTenantRoute: (call) => resolveTenantRouteFromKv(env.TENANT_ROUTING_KV, call.calledNumber),
    // A valid, enabled KV route is the admission gate. There is no secondary
    // tenant/phone allowlist in variables or secrets.
    isCanaryAllowed: () => true,
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
