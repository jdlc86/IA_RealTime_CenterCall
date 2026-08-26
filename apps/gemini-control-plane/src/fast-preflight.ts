import { buildFastGeminiMediaAdmission, provisionFastGeminiMediaAdmission } from "./admission/fast-media";
import { decodeTelnyxPublicKey } from "./telnyx/webhook-signature";
import type { FastGeminiCanaryEnv } from "./telnyx/fast-canary-route";

export type FastGeminiPreflightEnv = FastGeminiCanaryEnv & Readonly<{
  GEMINI_FAST_PREFLIGHT_NONCE: string;
}>;

type ProbeWebSocket = Readonly<{
  accept: () => void;
  close: (code?: number, reason?: string) => void;
}>;

type ProbeResponse = Response & Readonly<{ webSocket?: ProbeWebSocket | null }>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type PreflightDependencies = Readonly<{
  fetcher?: FetchLike;
  now?: () => number;
  randomUUID?: () => string;
}>;

type TelnyxRouteProbe = Readonly<{
  matches: boolean;
  connectionScope: "DEDICATED" | "SHARED" | "UNKNOWN";
}>;

function required(value: unknown, field: string, max = 64_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function requireMinBytes(value: unknown, field: string, minimum: number, max = 8_192): string {
  const normalized = required(value, field, max);
  if (new TextEncoder().encode(normalized).byteLength < minimum) throw new Error(`${field} is too short`);
  return normalized;
}

function normalizedPhone(value: unknown): string {
  const raw = required(value, "GEMINI_FAST_CANARY_CALLED_NUMBER", 64);
  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits || digits.length < 8 || digits.length > 15) throw new Error("GEMINI_FAST_CANARY_CALLED_NUMBER is invalid");
  return `${hasPlus ? "+" : ""}${digits}`;
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let diff = aa.length ^ bb.length;
  for (let index = 0; index < Math.min(aa.length, bb.length); index += 1) diff |= aa[index] ^ bb[index];
  return diff === 0;
}

async function authorized(request: Request, expectedNonce: string): Promise<boolean> {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return Boolean(match && await secureEqual(match[1], expectedNonce));
}

async function validateTelnyxPublicKey(value: string): Promise<void> {
  const material = decodeTelnyxPublicKey(value);
  await crypto.subtle.importKey(material.format, material.bytes, { name: "Ed25519" }, false, ["verify"]);
}

function upgradeUrl(edgeUrl: string): string {
  const parsed = new URL(edgeUrl);
  parsed.protocol = "https:";
  return parsed.toString();
}

function canonicalHttpUrl(value: unknown, field: string): string {
  const raw = required(value, field, 2_048);
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error(`${field} is invalid`);
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is invalid`);
  return value as Record<string, unknown>;
}

function objectArray(value: unknown, field: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${field} is invalid`);
  return value.map((entry) => objectRecord(entry, field));
}

async function telnyxJson(fetcher: FetchLike, url: string, apiKey: string): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    },
  });
  if (response.status !== 200) throw new Error("Telnyx routing lookup failed");
  return objectRecord(await response.json(), "Telnyx routing response");
}

async function probeTelnyxRouting(
  fetcher: FetchLike,
  apiKey: string,
  calledNumber: string,
  expectedWebhookUrl: string,
): Promise<TelnyxRouteProbe> {
  const numbersUrl = new URL("https://api.telnyx.com/v2/phone_numbers/slim");
  numbersUrl.searchParams.set("filter[phone_number]", calledNumber);
  numbersUrl.searchParams.set("page[size]", "2");
  const numbersBody = await telnyxJson(fetcher, numbersUrl.toString(), apiKey);
  const numbers = objectArray(numbersBody.data, "Telnyx phone numbers");
  const exact = numbers.filter((entry) => entry.phone_number === calledNumber);
  if (exact.length !== 1) throw new Error("Telnyx canary number lookup is ambiguous");
  if (exact[0].status !== "active") throw new Error("Telnyx canary number is not active");
  const connectionId = required(exact[0].connection_id, "Telnyx canary connection id", 256);

  const applicationBody = await telnyxJson(
    fetcher,
    `https://api.telnyx.com/v2/call_control_applications/${encodeURIComponent(connectionId)}`,
    apiKey,
  );
  const application = objectRecord(applicationBody.data, "Telnyx call control application");
  const configuredWebhook = canonicalHttpUrl(application.webhook_event_url, "Telnyx webhook event URL");
  const expectedWebhook = canonicalHttpUrl(expectedWebhookUrl, "Expected Gemini webhook URL");
  const active = application.active === true;

  let connectionScope: TelnyxRouteProbe["connectionScope"] = "UNKNOWN";
  try {
    const sharedUrl = new URL("https://api.telnyx.com/v2/phone_numbers/slim");
    sharedUrl.searchParams.set("filter[connection_id]", connectionId);
    sharedUrl.searchParams.set("page[size]", "2");
    const sharedBody = await telnyxJson(fetcher, sharedUrl.toString(), apiKey);
    const assigned = objectArray(sharedBody.data, "Telnyx connection phone numbers");
    connectionScope = assigned.length === 1 && assigned[0].phone_number === calledNumber ? "DEDICATED" : "SHARED";
  } catch {
    connectionScope = "UNKNOWN";
  }

  return Object.freeze({ matches: active && configuredWebhook === expectedWebhook, connectionScope });
}

async function probeAuthenticatedUpgrade(
  edgeUrl: string,
  streamingAuthToken: string,
  fetcher: FetchLike,
): Promise<void> {
  const response = await fetcher(upgradeUrl(edgeUrl), {
    headers: {
      Upgrade: "websocket",
      "x-telnyx-streaming-auth-token": streamingAuthToken,
    },
  }) as ProbeResponse;
  const socket = response.webSocket;
  if (!socket) throw new Error("authenticated websocket upgrade failed");
  socket.accept();
  socket.close(1000, "preflight");
}

export async function routeFastGeminiPreflight(
  request: Request,
  env: FastGeminiPreflightEnv,
  dependencies: PreflightDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  let preflightNonce: string;
  try {
    preflightNonce = requireMinBytes(env.GEMINI_FAST_PREFLIGHT_NONCE, "GEMINI_FAST_PREFLIGHT_NONCE", 32);
  } catch {
    return Response.json({ ok: false, status: "PREFLIGHT_UNAVAILABLE" }, { status: 503 });
  }
  if (!await authorized(request, preflightNonce)) {
    return Response.json({ ok: false, status: "UNAUTHORIZED" }, { status: 401 });
  }

  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID.bind(crypto);

  let config: Readonly<{
    telnyxApiKey: string;
    calledNumber: string;
    tenantId: string;
    edgeUrl: string;
    systemInstruction: string;
    credentialSecret: string;
    controlToken: string;
  }>;
  try {
    const telnyxApiKey = required(env.TELNYX_API_KEY, "TELNYX_API_KEY", 8_192);
    await validateTelnyxPublicKey(required(env.TELNYX_PUBLIC_KEY, "TELNYX_PUBLIC_KEY", 16_384));
    requireMinBytes(env.GEMINI_ADMISSION_IDENTITY_SECRET, "GEMINI_ADMISSION_IDENTITY_SECRET", 32);
    const credentialSecret = requireMinBytes(env.GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET, "GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET", 32);
    const controlToken = requireMinBytes(env.GEMINI_MEDIA_CONTROL_PLANE_TOKEN, "GEMINI_MEDIA_CONTROL_PLANE_TOKEN", 32);
    const calledNumber = normalizedPhone(env.GEMINI_FAST_CANARY_CALLED_NUMBER);
    const tenantId = required(env.GEMINI_FAST_CANARY_TENANT_ID, "GEMINI_FAST_CANARY_TENANT_ID", 256);
    const systemInstruction = required(env.GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION, "GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION", 64_000);
    const edgeUrl = required(env.GEMINI_FAST_CANARY_EDGE_URL, "GEMINI_FAST_CANARY_EDGE_URL", 2_048);
    config = Object.freeze({ telnyxApiKey, calledNumber, tenantId, edgeUrl, systemInstruction, credentialSecret, controlToken });
  } catch {
    return Response.json({ ok: false, status: "CONFIG_INVALID" }, { status: 500 });
  }

  let telnyxRoute: TelnyxRouteProbe;
  try {
    const expectedWebhookUrl = new URL("/webhooks/telnyx/fast-canary", request.url).toString();
    telnyxRoute = await probeTelnyxRouting(fetcher, config.telnyxApiKey, config.calledNumber, expectedWebhookUrl);
  } catch {
    return Response.json({ ok: false, status: "TELNYX_ROUTE_LOOKUP_FAILED" }, { status: 502 });
  }

  const timestamp = now();
  const credentialId = `preflight_${randomUUID()}`;
  let admission;
  try {
    admission = await buildFastGeminiMediaAdmission({
      tenantId: config.tenantId,
      callControlId: `preflight:${randomUUID()}`,
      credentialId,
      notAfterEpochMs: timestamp + 60_000,
      edgeUrl: config.edgeUrl,
      systemInstruction: config.systemInstruction,
      tools: [],
      voiceName: "Kore",
      languageCode: "es-ES",
      credentialSecret: config.credentialSecret,
    });
    await provisionFastGeminiMediaAdmission(admission, {
      controlToken: config.controlToken,
      fetcher,
    });
  } catch {
    return Response.json({ ok: false, status: "BOOTSTRAP_FAILED" }, { status: 502 });
  }

  try {
    await probeAuthenticatedUpgrade(admission.edgeUrl, admission.streamingAuthToken, fetcher);
  } catch {
    return Response.json({ ok: false, status: "WSS_AUTH_FAILED" }, { status: 502 });
  }

  if (!telnyxRoute.matches) {
    return Response.json({
      ok: false,
      status: "TELNYX_ROUTE_MISMATCH",
      connectionScope: telnyxRoute.connectionScope,
      checks: {
        mediaCredentialHmac: "VERIFIED",
        mediaControlToken: "VERIFIED",
        canaryEdge: "VERIFIED",
        bootstrap: "VERIFIED",
        websocketUpgrade: "VERIFIED",
      },
    }, { status: 409 });
  }

  return Response.json({
    ok: true,
    status: "READY",
    checks: {
      telnyxApiKey: "PRESENT",
      telnyxPublicKey: "PRESENT_VALID",
      telnyxRouting: "VERIFIED",
      admissionIdentitySecret: "PRESENT",
      mediaCredentialHmac: "VERIFIED",
      mediaControlToken: "VERIFIED",
      canaryEdge: "VERIFIED",
      canaryCalledNumber: "PRESENT",
      canaryTenant: "PRESENT",
      systemInstruction: "PRESENT",
      tools: "EMPTY",
      bootstrap: "VERIFIED",
      websocketUpgrade: "VERIFIED",
    },
  });
}
