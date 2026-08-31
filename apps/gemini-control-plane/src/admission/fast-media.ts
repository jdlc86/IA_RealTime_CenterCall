const FAST_BOOTSTRAP_VERSION = "gemini-fast-bootstrap.v2";
const FAST_PROVIDER = "GEMINI";
const FAST_SECURITY_VERSION = 1 as const;

export type FastGeminiToolDeclaration = Readonly<{
  name: string;
  capability: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;

export type FastSecurityContextV1 = Readonly<{
  securityVersion: typeof FAST_SECURITY_VERSION;
  sessionId: string;
  tenantId: string;
  routeId: string;
  callControlId: string;
  callerPhoneE164: string | null;
  calledPhoneE164: string;
  provider: "TELNYX";
  createdAtEpochMs: number;
  notAfterEpochMs: number;
}>;

export type FastGeminiMediaAdmission = Readonly<{
  edgeUrl: string;
  bootstrapUrl: string;
  streamingAuthToken: string;
  bootstrap: Readonly<{
    version: typeof FAST_BOOTSTRAP_VERSION;
    provider: typeof FAST_PROVIDER;
    credentialId: string;
    tenantId: string;
    callControlId: string;
    notAfterEpochMs: number;
    securityContext: FastSecurityContextV1;
    systemInstruction: string;
    tools: readonly FastGeminiToolDeclaration[];
    voiceName: string;
    languageCode: string;
  }>;
}>;

type FastGeminiMediaAdmissionInput = Readonly<{
  tenantId: string;
  callControlId: string;
  credentialId: string;
  notAfterEpochMs: number;
  edgeUrl: string;
  securityContext: FastSecurityContextV1;
  systemInstruction: string;
  tools?: readonly FastGeminiToolDeclaration[];
  voiceName?: string;
  languageCode?: string;
  credentialSecret: string;
}>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function required(value: unknown, field: string, max = 64_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function requiredText(value: unknown, field: string, max = 64_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /\u0000/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function safeEpoch(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} is invalid`);
  return value as number;
}

function canonicalE164(value: unknown, field: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined)) return null;
  const normalized = required(value, field, 16);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error(`${field} must be E.164`);
  return normalized;
}

function canonicalSecurityContext(value: FastSecurityContextV1, expected: Readonly<{ tenantId: string; callControlId: string; notAfterEpochMs: number }>): FastSecurityContextV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Fast Gemini security context is invalid");
  if (value.securityVersion !== FAST_SECURITY_VERSION) throw new Error("Fast Gemini security context version is invalid");
  if (value.provider !== "TELNYX") throw new Error("Fast Gemini security context provider is invalid");
  const tenantId = required(value.tenantId, "Fast Gemini security tenant id", 256);
  const callControlId = required(value.callControlId, "Fast Gemini security call control id", 512);
  const notAfterEpochMs = safeEpoch(value.notAfterEpochMs, "Fast Gemini security expiry");
  if (tenantId !== expected.tenantId || callControlId !== expected.callControlId || notAfterEpochMs !== expected.notAfterEpochMs) {
    throw new Error("Fast Gemini security context identity mismatch");
  }
  const createdAtEpochMs = safeEpoch(value.createdAtEpochMs, "Fast Gemini security createdAtEpochMs");
  if (createdAtEpochMs >= notAfterEpochMs) throw new Error("Fast Gemini security context lifetime is invalid");
  return Object.freeze({
    securityVersion: FAST_SECURITY_VERSION,
    sessionId: required(value.sessionId, "Fast Gemini security session id", 256),
    tenantId,
    routeId: required(value.routeId, "Fast Gemini security route id", 256),
    callControlId,
    callerPhoneE164: canonicalE164(value.callerPhoneE164, "Fast Gemini security caller phone", true),
    calledPhoneE164: canonicalE164(value.calledPhoneE164, "Fast Gemini security called phone") as string,
    provider: "TELNYX",
    createdAtEpochMs,
    notAfterEpochMs,
  });
}

function canonicalEdgeUrl(value: unknown): string {
  const raw = required(value, "Fast Gemini edge URL", 2_048);
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error("Fast Gemini edge URL is invalid"); }
  if (parsed.protocol !== "wss:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Fast Gemini edge URL must be a clean wss:// URL");
  }
  if (parsed.pathname !== "/telnyx/gemini") throw new Error("Fast Gemini edge URL path is invalid");
  return parsed.toString();
}

function bootstrapUrlFromEdge(edgeUrl: string): string {
  const parsed = new URL(edgeUrl);
  parsed.protocol = "https:";
  parsed.pathname = "/internal/bootstrap";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function canonicalTools(value: readonly FastGeminiToolDeclaration[] | undefined): readonly FastGeminiToolDeclaration[] {
  const tools = value ?? [];
  if (!Array.isArray(tools) || tools.length > 32) throw new Error("Fast Gemini tools are invalid");
  const names = new Set<string>();
  return Object.freeze(tools.map((tool, index) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error(`Fast Gemini tool ${index} is invalid`);
    const name = required(tool.name, `Fast Gemini tool ${index} name`, 128);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Fast Gemini tool ${index} name is invalid`);
    if (names.has(name)) throw new Error(`Fast Gemini tool ${index} name is duplicated`);
    names.add(name);
    const capability = required(tool.capability, `Fast Gemini tool ${index} capability`, 128);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(capability)) throw new Error(`Fast Gemini tool ${index} capability is invalid`);
    const description = required(tool.description, `Fast Gemini tool ${index} description`, 4_000);
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      throw new Error(`Fast Gemini tool ${index} parameters are invalid`);
    }
    return Object.freeze({ name, capability, description, parameters: structuredClone(tool.parameters) });
  }));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacSha256(secret: string, value: string): Promise<Uint8Array> {
  const secretBytes = new TextEncoder().encode(required(secret, "Fast Gemini credential secret", 8_192));
  if (secretBytes.byteLength < 32) throw new Error("Fast Gemini credential secret must be at least 32 bytes");
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

export async function buildFastGeminiMediaAdmission(input: FastGeminiMediaAdmissionInput): Promise<FastGeminiMediaAdmission> {
  const tenantId = required(input.tenantId, "Fast Gemini tenant id", 256);
  const callControlId = required(input.callControlId, "Fast Gemini call control id", 512);
  const credentialId = required(input.credentialId, "Fast Gemini credential id", 256);
  const notAfterEpochMs = safeEpoch(input.notAfterEpochMs, "Fast Gemini admission expiry");
  const edgeUrl = canonicalEdgeUrl(input.edgeUrl);
  const securityContext = canonicalSecurityContext(input.securityContext, { tenantId, callControlId, notAfterEpochMs });
  const systemInstruction = requiredText(input.systemInstruction, "Fast Gemini system instruction", 64_000);
  const tools = canonicalTools(input.tools);
  const voiceName = required(input.voiceName ?? "Kore", "Fast Gemini voice name", 128);
  const languageCode = required(input.languageCode ?? "es-ES", "Fast Gemini language code", 32);

  const claims = Object.freeze({
    credentialId,
    provider: FAST_PROVIDER,
    tenantId,
    callControlId,
    sessionId: securityContext.sessionId,
    routeId: securityContext.routeId,
    callerPhoneE164: securityContext.callerPhoneE164,
    calledPhoneE164: securityContext.calledPhoneE164,
    securityVersion: securityContext.securityVersion,
    edgeUrl,
    targetLegs: "both",
    notAfterEpochMs,
  });
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `v1.${payload}`;
  const signature = base64url(await hmacSha256(input.credentialSecret, signingInput));
  const streamingAuthToken = `${signingInput}.${signature}`;

  return Object.freeze({
    edgeUrl,
    bootstrapUrl: bootstrapUrlFromEdge(edgeUrl),
    streamingAuthToken,
    bootstrap: Object.freeze({
      version: FAST_BOOTSTRAP_VERSION,
      provider: FAST_PROVIDER,
      credentialId,
      tenantId,
      callControlId,
      notAfterEpochMs,
      securityContext,
      systemInstruction,
      tools,
      voiceName,
      languageCode,
    }),
  });
}

export async function provisionFastGeminiMediaAdmission(
  admission: FastGeminiMediaAdmission,
  options: Readonly<{ controlToken: string; fetcher?: FetchLike }>,
): Promise<void> {
  const controlToken = required(options.controlToken, "Fast Gemini media control token", 8_192);
  if (new TextEncoder().encode(controlToken).byteLength < 32) throw new Error("Fast Gemini media control token must be at least 32 bytes");
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(admission.bootstrapUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${controlToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(admission.bootstrap),
  });
  let body: unknown = null;
  try { body = await response.json(); } catch {}
  if (response.status !== 201 || !body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Fast Gemini media bootstrap provisioning failed");
  }
  const record = body as Record<string, unknown>;
  if (record.ok !== true || record.credentialId !== admission.bootstrap.credentialId) {
    throw new Error("Fast Gemini media bootstrap acknowledgement is invalid");
  }
}
