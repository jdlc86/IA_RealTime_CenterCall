import { startSignedFastGeminiIncomingCall, type FastIncomingRuntimeOptions, type FastIncomingRuntimeResult, type FastTenantRoute } from "./fast-incoming-runtime";

type TenantRoutingKv = Readonly<{
  get(key: string): Promise<string | null>;
}>;

type TenantCapabilities = Readonly<{
  "call.transfer": boolean;
  "message.whatsapp.transactional": boolean;
  "message.whatsapp.realtime_support": boolean;
}>;

const DEFAULT_CAPABILITIES: TenantCapabilities = Object.freeze({
  "call.transfer": false,
  "message.whatsapp.transactional": false,
  "message.whatsapp.realtime_support": false,
});

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

function optionalString(value: unknown, field: string, max = 4_000): string | null {
  if (value == null) return null;
  return required(value, field, max);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(raw: string | null, field: string): unknown | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; }
  catch { throw new Error(`${field} is invalid JSON`); }
}

function canonicalE164(value: string): string {
  const normalized = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error("Called number must be E.164");
  return normalized;
}

function canonicalTenantRoute(value: unknown): FastTenantRoute | null {
  const route = record(value);
  if (!route || route.enabled !== true) return null;
  const tenantId = required(route.tenant_id, "KV tenant_id", 256);
  const routeId = route.route_id == null ? "default" : required(route.route_id, "KV route_id", 256);
  return Object.freeze({ tenantId, routeId });
}

async function resolveTenantRouteFromKv(kv: TenantRoutingKv, calledNumber: string): Promise<FastTenantRoute | null> {
  const e164 = canonicalE164(calledNumber);
  return canonicalTenantRoute(parseJson(await kv.get(`tenant_by_phone:${e164}`), "Tenant routing KV value"));
}

function capabilityValue(source: Record<string, unknown> | null, flatKey: keyof TenantCapabilities, category: "call" | "whatsapp", nestedKey: string): boolean {
  if (!source) return false;
  if (typeof source[flatKey] === "boolean") return source[flatKey] as boolean;
  const nested = record(source[category]);
  return nested?.[nestedKey] === true;
}

function canonicalCapabilities(value: unknown, tenantId: string): TenantCapabilities {
  if (value == null) return DEFAULT_CAPABILITIES;
  const source = record(value);
  if (!source) throw new Error("Tenant capabilities KV value is invalid");
  const declaredTenant = source.tenant_id ?? source.tenantId;
  if (declaredTenant != null && required(declaredTenant, "Tenant capabilities tenant id", 256) !== tenantId) {
    throw new Error("Tenant capabilities tenant mismatch");
  }
  return Object.freeze({
    "call.transfer": capabilityValue(source, "call.transfer", "call", "transfer"),
    "message.whatsapp.transactional": capabilityValue(source, "message.whatsapp.transactional", "whatsapp", "transactional"),
    "message.whatsapp.realtime_support": capabilityValue(source, "message.whatsapp.realtime_support", "whatsapp", "realtime_support"),
  });
}

function capabilityInstruction(capabilities: TenantCapabilities): string {
  return [
    "Capacidades configuradas para esta sesión (el kernel es la autoridad final):",
    `- call.transfer=${capabilities["call.transfer"]}`,
    `- message.whatsapp.transactional=${capabilities["message.whatsapp.transactional"]}`,
    `- message.whatsapp.realtime_support=${capabilities["message.whatsapp.realtime_support"]}`,
    "No afirmes haber ejecutado una capacidad si la herramienta correspondiente no está disponible o no confirma éxito.",
  ].join("\n");
}

function buildTenantInstruction(baseInstruction: string, value: unknown, tenantId: string, capabilities: TenantCapabilities): Readonly<{ systemInstruction: string; languageCode: string }> {
  if (value == null) {
    return Object.freeze({ systemInstruction: baseInstruction, languageCode: "es-ES" });
  }
  const config = record(value);
  if (!config) throw new Error("Tenant config KV value is invalid");
  const declaredTenant = config.tenant_id ?? config.tenantId;
  if (declaredTenant != null && required(declaredTenant, "Tenant config tenant id", 256) !== tenantId) {
    throw new Error("Tenant config tenant mismatch");
  }
  if (config.status != null && config.status !== "active") throw new Error("Tenant config is not active");

  const business = record(config.business);
  const assistant = record(config.assistant);
  const displayName = optionalString(business?.display_name ?? business?.displayName, "Tenant business display name", 256);
  const assistantName = optionalString(assistant?.name, "Tenant assistant name", 128);
  const greeting = optionalString(assistant?.greeting, "Tenant assistant greeting", 2_000);
  const language = optionalString(assistant?.language, "Tenant assistant language", 32) ?? "es-ES";
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) throw new Error("Tenant assistant language is invalid");

  const waiting = assistant?.waiting_phrases ?? assistant?.waitingPhrases;
  const waitingPhrases = waiting == null ? [] : (() => {
    if (!Array.isArray(waiting) || waiting.length > 16) throw new Error("Tenant assistant waiting phrases are invalid");
    return waiting.map((entry, index) => required(entry, `Tenant waiting phrase ${index}`, 512));
  })();

  const tenantLines = [
    displayName ? `Negocio: ${displayName}.` : null,
    assistantName ? `Tu nombre de asistente es ${assistantName}.` : null,
    greeting ? `Saludo configurado: ${greeting}` : null,
    waitingPhrases.length ? `Frases de espera permitidas: ${waitingPhrases.join(" | ")}` : null,
    capabilityInstruction(capabilities),
  ].filter((entry): entry is string => Boolean(entry));

  return Object.freeze({
    systemInstruction: `${baseInstruction}\n\n${tenantLines.join("\n")}`,
    languageCode: language,
  });
}

async function resolveTenantSessionConfig(kv: TenantRoutingKv, tenantId: string, baseInstruction: string) {
  // These two reads are pre-call configuration only and run in parallel. No KV
  // access is performed in the media/audio hot path.
  const [configRaw, capabilitiesRaw] = await Promise.all([
    kv.get(`tenant_config:${tenantId}`),
    kv.get(`tenant_capabilities:${tenantId}`),
  ]);
  const capabilities = canonicalCapabilities(parseJson(capabilitiesRaw, "Tenant capabilities KV value"), tenantId);
  const tenant = buildTenantInstruction(baseInstruction, parseJson(configRaw, "Tenant config KV value"), tenantId, capabilities);
  return Object.freeze({
    systemInstruction: tenant.systemInstruction,
    tools: [],
    // Realtime voice/VAD remain on the already-stable defaults. Tenant KV does
    // not override them in this version.
    voiceName: "Kore",
    languageCode: tenant.languageCode,
  });
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
    resolveSessionConfig: (tenantId) => resolveTenantSessionConfig(env.TENANT_ROUTING_KV, tenantId, systemInstruction),
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
