import { buildFastGeminiMediaAdmission, provisionFastGeminiMediaAdmission } from "./admission/fast-media";
import { decodeTelnyxPublicKey } from "./telnyx/webhook-signature";
import type { FastGeminiCanaryEnv } from "./telnyx/fast-canary-route";

export type FastGeminiPreflightEnv = FastGeminiCanaryEnv & Readonly<{
  GEMINI_FAST_PREFLIGHT_TOKEN: string;
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

async function authorized(request: Request, expectedToken: string): Promise<boolean> {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return Boolean(match && await secureEqual(match[1], expectedToken));
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

  let preflightToken: string;
  try {
    preflightToken = requireMinBytes(env.GEMINI_FAST_PREFLIGHT_TOKEN, "GEMINI_FAST_PREFLIGHT_TOKEN", 32);
  } catch {
    return Response.json({ ok: false, status: "PREFLIGHT_UNAVAILABLE" }, { status: 503 });
  }
  if (!await authorized(request, preflightToken)) {
    return Response.json({ ok: false, status: "UNAUTHORIZED" }, { status: 401 });
  }

  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID.bind(crypto);

  let config: Readonly<{
    tenantId: string;
    edgeUrl: string;
    systemInstruction: string;
    credentialSecret: string;
    controlToken: string;
  }>;
  try {
    required(env.TELNYX_API_KEY, "TELNYX_API_KEY", 8_192);
    await validateTelnyxPublicKey(required(env.TELNYX_PUBLIC_KEY, "TELNYX_PUBLIC_KEY", 16_384));
    requireMinBytes(env.GEMINI_ADMISSION_IDENTITY_SECRET, "GEMINI_ADMISSION_IDENTITY_SECRET", 32);
    const credentialSecret = requireMinBytes(env.GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET, "GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET", 32);
    const controlToken = requireMinBytes(env.GEMINI_MEDIA_CONTROL_PLANE_TOKEN, "GEMINI_MEDIA_CONTROL_PLANE_TOKEN", 32);
    normalizedPhone(env.GEMINI_FAST_CANARY_CALLED_NUMBER);
    const tenantId = required(env.GEMINI_FAST_CANARY_TENANT_ID, "GEMINI_FAST_CANARY_TENANT_ID", 256);
    const systemInstruction = required(env.GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION, "GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION", 64_000);
    const edgeUrl = required(env.GEMINI_FAST_CANARY_EDGE_URL, "GEMINI_FAST_CANARY_EDGE_URL", 2_048);
    config = Object.freeze({ tenantId, edgeUrl, systemInstruction, credentialSecret, controlToken });
  } catch {
    return Response.json({ ok: false, status: "CONFIG_INVALID" }, { status: 500 });
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

  return Response.json({
    ok: true,
    status: "READY",
    checks: {
      telnyxApiKey: "PRESENT",
      telnyxPublicKey: "PRESENT_VALID",
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
