import { startSignedFastGeminiIncomingCall, type FastIncomingRuntimeOptions, type FastIncomingRuntimeResult, type FastTenantRoute } from "./fast-incoming-runtime";
import { verifyTelnyxWebhookSignature } from "./webhook-signature";
import {
  FAST_TRANSFER_TOOL,
  fastHumanHandoffPrompt,
  handleVerifiedFastHumanHandoffEvent,
  isFastHumanHandoffEventType,
  parseFastHumanHandoffConfig,
} from "./fast-human-handoff";
import type { FastHumanHandoffAuditDependencies } from "./fast-human-handoff-audit";
import {
  FAST_AUTHORITATIVE_DATETIME_TOOL,
  buildFastAuthoritativeDateTimeSnapshot,
  fastTemporalAuthorityInstruction,
  resolveFastTenantTimeZone,
} from "../fast-temporal-authority";
import {
  FAST_SEMANTIC_SECURITY_TOOL,
  fastSemanticSecurityInstruction,
} from "../fast-semantic-security-boundary";

type TenantRoutingKv = Readonly<{
  get(key: string): Promise<string | null>;
  put?(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
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
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}>;

type StartIncoming = (
  input: Readonly<{ rawBody: string; signatureBase64: string | null; timestamp: string | null }>,
  options: FastIncomingRuntimeOptions,
) => Promise<FastIncomingRuntimeResult>;

type RouteDependencies = Readonly<{
  startIncoming?: StartIncoming;
  now?: () => number;
  handoffAudit?: FastHumanHandoffAuditDependencies;
}>;

function required(value: unknown, field: string, max = 64_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function optionalString(value: unknown, field: string, max = 4_000): string | null {
  return value == null ? null : required(value, field, max);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(raw: string | null, field: string): unknown | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; }
  catch { throw new Error(`${field} is invalid JSON`); }
}

function eventType(rawBody: string): string | null {
  try {
    const data = record(record(JSON.parse(rawBody))?.data);
    return typeof data?.event_type === "string" ? data.event_type : null;
  } catch { return null; }
}

function canonicalE164(value: string): string {
  const normalized = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error("Called number must be E.164");
  return normalized;
}

function canonicalTenantRoute(value: unknown): FastTenantRoute | null {
  const route = record(value);
  if (!route || route.enabled !== true) return null;
  return Object.freeze({
    tenantId: required(route.tenant_id, "KV tenant_id", 256),
    routeId: route.route_id == null ? "default" : required(route.route_id, "KV route_id", 256),
  });
}

async function resolveTenantRouteFromKv(kv: TenantRoutingKv, calledNumber: string): Promise<FastTenantRoute | null> {
  const e164 = canonicalE164(calledNumber);
  return canonicalTenantRoute(parseJson(await kv.get(`tenant_by_phone:${e164}`), "Tenant routing KV value"));
}

function capabilityValue(source: Record<string, unknown> | null, flatKey: keyof TenantCapabilities, category: "call" | "whatsapp", nestedKey: string): boolean {
  if (!source) return false;
  if (typeof source[flatKey] === "boolean") return source[flatKey] as boolean;
  return record(source[category])?.[nestedKey] === true;
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

function buildTenantInstruction(
  baseInstruction: string,
  value: unknown,
  tenantId: string,
  capabilities: TenantCapabilities,
  nowEpochMs: number,
) {
  const config = value == null ? null : record(value);
  if (value != null && !config) throw new Error("Tenant config KV value is invalid");
  const declaredTenant = config?.tenant_id ?? config?.tenantId;
  if (declaredTenant != null && required(declaredTenant, "Tenant config tenant id", 256) !== tenantId) throw new Error("Tenant config tenant mismatch");
  if (config?.status != null && config.status !== "active") throw new Error("Tenant config is not active");

  const business = record(config?.business);
  const assistant = record(config?.assistant);
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

  const timezone = resolveFastTenantTimeZone(value);
  const temporalSnapshot = buildFastAuthoritativeDateTimeSnapshot(timezone, nowEpochMs);
  const handoff = config ? parseFastHumanHandoffConfig(config) : null;
  const transferEnabled = capabilities["call.transfer"] && Boolean(handoff?.enabled);
  const lines = [
    displayName ? `Negocio: ${displayName}.` : null,
    assistantName ? `Tu nombre de asistente es ${assistantName}.` : null,
    greeting ? `Saludo configurado: ${greeting}` : null,
    waitingPhrases.length ? `Frases de espera permitidas: ${waitingPhrases.join(" | ")}` : null,
    capabilityInstruction(capabilities),
    fastTemporalAuthorityInstruction(temporalSnapshot),
    fastSemanticSecurityInstruction(),
    transferEnabled && handoff ? fastHumanHandoffPrompt(handoff) : null,
  ].filter((entry): entry is string => Boolean(entry));

  return Object.freeze({
    systemInstruction: `${baseInstruction}${lines.length ? `\n\n${lines.join("\n")}` : ""}`,
    languageCode: language,
    tools: Object.freeze([
      FAST_AUTHORITATIVE_DATETIME_TOOL,
      FAST_SEMANTIC_SECURITY_TOOL,
      ...(transferEnabled ? [FAST_TRANSFER_TOOL] : []),
    ]),
  });
}

async function resolveTenantSessionConfig(
  kv: TenantRoutingKv,
  tenantId: string,
  baseInstruction: string,
  nowEpochMs: number,
) {
  // Both reads are pre-call only and parallel; no KV access is added to audio forwarding.
  const [configRaw, capabilitiesRaw] = await Promise.all([
    kv.get(`tenant_config:${tenantId}`),
    kv.get(`tenant_capabilities:${tenantId}`),
  ]);
  const configValue = parseJson(configRaw, "Tenant config KV value");
  const capabilities = canonicalCapabilities(parseJson(capabilitiesRaw, "Tenant capabilities KV value"), tenantId);
  const tenant = buildTenantInstruction(baseInstruction, configValue, tenantId, capabilities, nowEpochMs);
  return Object.freeze({
    systemInstruction: tenant.systemInstruction,
    tools: tenant.tools,
    // Stable Gemini realtime settings are intentionally untouched.
    voiceName: "Kore",
    languageCode: tenant.languageCode,
  });
}

export async function routeFastGeminiCanaryWebhook(request: Request, env: FastGeminiCanaryEnv, dependencies: RouteDependencies = {}): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const rawBody = await request.text();
  if (rawBody.length > 512_000) return new Response("payload too large", { status: 413 });
  if (!env.TENANT_ROUTING_KV || typeof env.TENANT_ROUTING_KV.get !== "function") throw new Error("TENANT_ROUTING_KV binding is required");

  const now = dependencies.now ?? Date.now;
  const incomingEventType = eventType(rawBody);
  if (isFastHumanHandoffEventType(incomingEventType)) {
    const valid = await verifyTelnyxWebhookSignature({
      rawBody,
      signatureBase64: request.headers.get("telnyx-signature-ed25519"),
      timestamp: request.headers.get("telnyx-timestamp"),
      publicKey: env.TELNYX_PUBLIC_KEY,
      nowEpochMs: now(),
      maxAgeSeconds: 300,
    });
    if (!valid) return Response.json({ ok: false, status: "SIGNATURE_REJECTED" }, { status: 401 });
    await handleVerifiedFastHumanHandoffEvent(rawBody, env, dependencies.handoffAudit);
    return new Response(null, { status: 204 });
  }

  const requestNowEpochMs = now();
  const systemInstruction = required(env.GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION, "GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION", 64_000);
  const startIncoming = dependencies.startIncoming ?? startSignedFastGeminiIncomingCall;
  const result = await startIncoming({
    rawBody,
    signatureBase64: request.headers.get("telnyx-signature-ed25519"),
    timestamp: request.headers.get("telnyx-timestamp"),
  }, {
    nowEpochMs: requestNowEpochMs,
    signatureMaxAgeSeconds: 300,
    admissionTtlMs: 60_000,
    telnyxPublicKey: env.TELNYX_PUBLIC_KEY,
    admissionIdentitySecret: env.GEMINI_ADMISSION_IDENTITY_SECRET,
    mediaCredentialSecret: env.GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET,
    mediaControlToken: env.GEMINI_MEDIA_CONTROL_PLANE_TOKEN,
    telnyxApiKey: env.TELNYX_API_KEY,
    edgeUrl: env.GEMINI_FAST_CANARY_EDGE_URL,
    resolveTenantRoute: (call) => resolveTenantRouteFromKv(env.TENANT_ROUTING_KV, call.calledNumber),
    isCanaryAllowed: () => true,
    resolveSessionConfig: (tenantId) => resolveTenantSessionConfig(
      env.TENANT_ROUTING_KV,
      tenantId,
      systemInstruction,
      requestNowEpochMs,
    ),
  });

  switch (result.status) {
    case "SIGNATURE_REJECTED": return Response.json({ ok: false, status: result.status }, { status: 401 });
    case "IGNORED_EVENT": return new Response(null, { status: 204 });
    case "TENANT_NOT_FOUND":
    case "CANARY_NOT_ALLOWED": return Response.json({ ok: false, status: result.status }, { status: 403 });
    case "STARTED": return Response.json({ ok: true, status: result.status }, { status: 202 });
  }
}
