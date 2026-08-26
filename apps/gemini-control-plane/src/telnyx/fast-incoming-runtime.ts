import { buildFastGeminiMediaAdmission, provisionFastGeminiMediaAdmission, type FastGeminiToolDeclaration } from "../admission/fast-media";
import { issueGeminiAdmissionIdentity } from "../admission/identity-issuer";
import { answerFastGeminiTelnyxCall, startFastGeminiTelnyxStreaming } from "./fast-call-control";
import { parseVerifiedTelnyxIncomingCall, type VerifiedTelnyxIncomingCall } from "./incoming-call";
import { verifyTelnyxWebhookSignature } from "./webhook-signature";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FastSessionConfig = Readonly<{
  systemInstruction: string;
  tools?: readonly FastGeminiToolDeclaration[];
  voiceName?: string;
  languageCode?: string;
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
  resolveTenantId: (call: VerifiedTelnyxIncomingCall) => Promise<string | null>;
  isCanaryAllowed: (tenantId: string, call: VerifiedTelnyxIncomingCall) => boolean;
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
  | Readonly<{ status: "STARTED"; call: VerifiedTelnyxIncomingCall; tenantId: string; credentialId: string; edgeUrl: string }>;

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
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
  const tenantId = await options.resolveTenantId(call);
  if (!tenantId) return Object.freeze({ status: "TENANT_NOT_FOUND", call });
  if (!options.isCanaryAllowed(tenantId, call)) {
    return Object.freeze({ status: "CANARY_NOT_ALLOWED", call, tenantId });
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
  const config = await options.resolveSessionConfig(tenantId, call);
  const admission = await buildFastGeminiMediaAdmission({
    tenantId,
    callControlId: call.callControlId,
    credentialId: ids.credentialId,
    notAfterEpochMs,
    edgeUrl: options.edgeUrl,
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
    credentialId: ids.credentialId,
    edgeUrl: admission.edgeUrl,
  });
}
