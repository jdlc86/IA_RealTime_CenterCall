import { buildFastGeminiMediaAdmission, provisionFastGeminiMediaAdmission, type FastGeminiToolDeclaration } from "../admission/fast-media";
import { issueGeminiAdmissionIdentity } from "../admission/identity-issuer";
import { answerFastGeminiTelnyxCall, startFastGeminiTelnyxStreaming } from "./fast-call-control";
import { parseVerifiedTelnyxIncomingCall, type VerifiedTelnyxIncomingCall } from "./incoming-call";
import { verifyTelnyxWebhookSignature } from "./webhook-signature";
import type { FastInboundCallerSecurityDecision, FastInboundCallerSecurityInput } from "../fast-caller-security";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FastSessionConfig = Readonly<{
  systemInstruction: string;
  tools?: readonly FastGeminiToolDeclaration[];
  voiceName?: string;
  languageCode?: string;
}>;

export type FastTenantRoute = Readonly<{
  tenantId: string;
  routeId: string;
}>;

export type FastIncomingRuntimeOptions = Readonly<{
  nowEpochMs: number;
  signatureMaxAgeSeconds: number;
  admissionTtlMs: number;
  telnyxPublicKey: string;
  admissionIdentitySecret: string;
  mediaCredentialSecret: string;
  mediaControlToken: string;
  telnyxApiKey: string;
  edgeUrl: string;
  resolveTenantRoute?: (call: VerifiedTelnyxIncomingCall) => Promise<FastTenantRoute | null>;
  resolveTenantId?: (call: VerifiedTelnyxIncomingCall) => Promise<string | null>;
  isCanaryAllowed: (tenantId: string, call: VerifiedTelnyxIncomingCall) => boolean;
  evaluateCallerSecurity: (input: FastInboundCallerSecurityInput) => Promise<FastInboundCallerSecurityDecision>;
  resolveSessionConfig: (tenantId: string, call: VerifiedTelnyxIncomingCall) => Promise<FastSessionConfig>;
  mediaFetcher?: FetchLike;
  telnyxFetcher?: FetchLike;
  verifySignature?: typeof verifyTelnyxWebhookSignature;
}>;

export type FastIncomingRuntimeResult =
  | Readonly<{ status: "SIGNATURE_REJECTED" }>
  | Readonly<{ status: "IGNORED_EVENT" }>
  | Readonly<{ status: "TENANT_NOT_FOUND"; call: VerifiedTelnyxIncomingCall }>
  | Readonly<{ status: "CANARY_NOT_ALLOWED"; call: VerifiedTelnyxIncomingCall; tenantId: string }>
  | Readonly<{ status: "CALLER_SECURITY_BLOCKED"; call: VerifiedTelnyxIncomingCall; tenantId: string; reason: string }>
  | Readonly<{ status: "STARTED"; call: VerifiedTelnyxIncomingCall; tenantId: string; routeId: string; credentialId: string; edgeUrl: string }>;

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function required(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n\t]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function e164(value: string | null, field: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  const normalized = required(value, field, 16);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error(`${field} must be E.164`);
  return normalized;
}

function signedEventType(rawBody: string): string | null {
  let value: unknown;
  try { value = JSON.parse(rawBody); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const eventType = (data as Record<string, unknown>).event_type;
  return typeof eventType === "string" ? eventType : null;
}

function commandId(credentialId: string, action: "answer" | "stream"): string {
  const compact = credentialId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  if (!compact) throw new Error("Fast Gemini credential id cannot produce a command id");
  return `gemini-fast-${action}-${compact}`;
}

async function resolveTenantRoute(call: VerifiedTelnyxIncomingCall, options: FastIncomingRuntimeOptions): Promise<FastTenantRoute | null> {
  if (options.resolveTenantRoute) {
    const route = await options.resolveTenantRoute(call);
    if (!route) return null;
    return Object.freeze({
      tenantId: required(route.tenantId, "Fast incoming tenant id", 256),
      routeId: required(route.routeId, "Fast incoming route id", 256),
    });
  }
  if (!options.resolveTenantId) throw new Error("Fast incoming tenant resolver is required");
  const tenantId = await options.resolveTenantId(call);
  if (!tenantId) return null;
  return Object.freeze({ tenantId: required(tenantId, "Fast incoming tenant id", 256), routeId: "default" });
}

/**
 * Pre-call orchestrator for the low-latency product. Its last network action is
 * Telnyx streaming_start. It has no conversational lifecycle after that point.
 */
export async function startSignedFastGeminiIncomingCall(
  input: Readonly<{ rawBody: string; signatureBase64: string | null; timestamp: string | null }>,
  options: FastIncomingRuntimeOptions,
): Promise<FastIncomingRuntimeResult> {
  const nowEpochMs = positive(options.nowEpochMs, "Fast incoming nowEpochMs");
  const signatureMaxAgeSeconds = positive(options.signatureMaxAgeSeconds, "Fast incoming signature max age");
  const admissionTtlMs = positive(options.admissionTtlMs, "Fast incoming admission TTL");
  const verifySignature = options.verifySignature ?? verifyTelnyxWebhookSignature;

  const signatureValid = await verifySignature({
    rawBody: input.rawBody,
    signatureBase64: input.signatureBase64,
    timestamp: input.timestamp,
    publicKey: options.telnyxPublicKey,
    nowEpochMs,
    maxAgeSeconds: signatureMaxAgeSeconds,
  });
  if (!signatureValid) return Object.freeze({ status: "SIGNATURE_REJECTED" });
  if (signedEventType(input.rawBody) !== "call.initiated") return Object.freeze({ status: "IGNORED_EVENT" });

  const call = parseVerifiedTelnyxIncomingCall(input.rawBody);
  const route = await resolveTenantRoute(call, options);
  if (!route) return Object.freeze({ status: "TENANT_NOT_FOUND", call });
  const { tenantId, routeId } = route;
  if (!options.isCanaryAllowed(tenantId, call)) {
    return Object.freeze({ status: "CANARY_NOT_ALLOWED", call, tenantId });
  }

  const callerPhone = e164(call.callerNumber, "Telnyx caller number") as string;
  const callerSecurity = await options.evaluateCallerSecurity({
    eventKey: call.eventId,
    tenantId,
    callerPhone,
  });
  if (callerSecurity.decision !== "ALLOW") {
    return Object.freeze({
      status: "CALLER_SECURITY_BLOCKED",
      call,
      tenantId,
      reason: required(callerSecurity.reason, "Fast caller security reason", 128),
    });
  }

  const ids = await issueGeminiAdmissionIdentity({
    tenantId,
    telnyxEventId: call.eventId,
    callControlId: call.callControlId,
    secret: options.admissionIdentitySecret,
  });
  const notAfterEpochMs = call.occurredAtEpochMs + admissionTtlMs;
  if (!Number.isSafeInteger(notAfterEpochMs) || notAfterEpochMs <= nowEpochMs) {
    throw new Error("Fast Gemini incoming admission has expired");
  }
  const securityContext = Object.freeze({
    securityVersion: 1 as const,
    sessionId: ids.callSessionId,
    tenantId,
    routeId,
    callControlId: call.callControlId,
    callerPhoneE164: callerPhone,
    calledPhoneE164: e164(call.calledNumber, "Telnyx called number") as string,
    provider: "TELNYX" as const,
    createdAtEpochMs: call.occurredAtEpochMs,
    notAfterEpochMs,
  });
  const config = await options.resolveSessionConfig(tenantId, call);
  const admission = await buildFastGeminiMediaAdmission({
    tenantId,
    callControlId: call.callControlId,
    credentialId: ids.credentialId,
    notAfterEpochMs,
    edgeUrl: options.edgeUrl,
    securityContext,
    systemInstruction: config.systemInstruction,
    tools: config.tools ?? [],
    voiceName: config.voiceName,
    languageCode: config.languageCode,
    credentialSecret: options.mediaCredentialSecret,
  });

  const answerCommandId = commandId(ids.credentialId, "answer");
  const streamCommandId = commandId(ids.credentialId, "stream");

  // Parallel preconditions save one establishment RTT while still ensuring that
  // streaming starts only after both Telnyx answer and Edge bootstrap succeed.
  await Promise.all([
    provisionFastGeminiMediaAdmission(admission, {
      controlToken: options.mediaControlToken,
      ...(options.mediaFetcher ? { fetcher: options.mediaFetcher } : {}),
    }),
    answerFastGeminiTelnyxCall({ callControlId: call.callControlId, commandId: answerCommandId }, {
      apiKey: options.telnyxApiKey,
      ...(options.telnyxFetcher ? { fetcher: options.telnyxFetcher } : {}),
    }),
  ]);

  await startFastGeminiTelnyxStreaming({
    callControlId: call.callControlId,
    edgeUrl: admission.edgeUrl,
    streamAuthToken: admission.streamingAuthToken,
    commandId: streamCommandId,
  }, {
    apiKey: options.telnyxApiKey,
    ...(options.telnyxFetcher ? { fetcher: options.telnyxFetcher } : {}),
  });

  return Object.freeze({
    status: "STARTED",
    call,
    tenantId,
    routeId,
    credentialId: ids.credentialId,
    edgeUrl: admission.edgeUrl,
  });
}
