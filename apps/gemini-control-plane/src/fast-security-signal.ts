export type FastSecuritySignalEnv = Readonly<{
  GEMINI_MEDIA_CONTROL_PLANE_TOKEN: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FastSecuritySignalDependencies = Readonly<{
  fetcher?: FetchLike;
}>;

const CATEGORIES = new Set([
  "PROMPT_EXFILTRATION",
  "PROMPT_INJECTION",
  "ROLE_ESCALATION",
  "TOOL_MANIPULATION",
]);

function required(value: unknown, field: string, max = 8_192): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function e164(value: unknown): string {
  const normalized = required(value, "callerPhoneE164", 16);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error("callerPhoneE164 is invalid");
  return normalized;
}

function canonicalSupabaseUrl(value: unknown): string {
  const parsed = new URL(required(value, "SUPABASE_URL", 2_048));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("SUPABASE_URL is invalid");
  }
  return parsed.toString().replace(/\/$/, "");
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

async function authorized(request: Request, expected: string): Promise<boolean> {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return Boolean(match && await secureEqual(match[1], expected));
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("security signal is invalid");
  const input = value as Record<string, unknown>;
  const category = required(input.category, "category", 64);
  if (!CATEGORIES.has(category)) throw new Error("category is invalid");
  const keys = Object.keys(input).sort();
  const expected = ["callControlId", "callerPhoneE164", "category", "tenantId", "toolCallId"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("security signal fields are invalid");
  return Object.freeze({
    tenantId: required(input.tenantId, "tenantId", 256),
    callControlId: required(input.callControlId, "callControlId", 512),
    callerPhoneE164: e164(input.callerPhoneE164),
    toolCallId: required(input.toolCallId, "toolCallId", 256),
    category,
  });
}

export async function routeFastSecuritySignal(
  request: Request,
  env: FastSecuritySignalEnv,
  dependencies: FastSecuritySignalDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  let controlToken: string;
  try { controlToken = required(env.GEMINI_MEDIA_CONTROL_PLANE_TOKEN, "GEMINI_MEDIA_CONTROL_PLANE_TOKEN"); }
  catch { return Response.json({ ok: false, status: "SECURITY_SIGNAL_UNAVAILABLE" }, { status: 503 }); }
  if (!await authorized(request, controlToken)) return Response.json({ ok: false, status: "UNAUTHORIZED" }, { status: 401 });

  let supabaseUrl: string;
  let serviceRoleKey: string;
  try {
    supabaseUrl = canonicalSupabaseUrl(env.SUPABASE_URL);
    serviceRoleKey = required(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY", 16_384);
  } catch {
    return Response.json({ ok: false, status: "SECURITY_SIGNAL_NOT_CONFIGURED" }, { status: 503 });
  }

  let input: ReturnType<typeof canonicalInput>;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 8_192) throw new Error("security signal payload too large");
    input = canonicalInput(JSON.parse(text));
  } catch {
    return Response.json({ ok: false, status: "INVALID_SECURITY_SIGNAL" }, { status: 400 });
  }

  const callerKey = await hmacHex(serviceRoleKey, `${input.tenantId}|${input.callerPhoneE164}`);
  const eventDigest = await sha256Hex(`gemini-fast-semantic-security-v1|${input.tenantId}|${input.callControlId}|${input.toolCallId}|${input.category}`);
  const eventKey = `gemini-fast-semsec-v1:${eventDigest}`;
  const fetcher = dependencies.fetcher ?? fetch;
  const response = await fetcher(`${supabaseUrl}/rest/v1/rpc/record_caller_security_signal_v2`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      p_event_key: eventKey,
      p_tenant_id: input.tenantId,
      p_caller_key: callerKey,
      p_event_type: `GEMINI_SEMANTIC_${input.category}`,
      p_severity: "MEDIUM",
      p_risk_delta: 1,
      p_metadata: {
        source: "GEMINI_FAST_SEMANTIC_BOUNDARY",
        category: input.category,
        raw_transcript_stored: false,
      },
      p_high_confidence: false,
    }),
  });
  if (!response.ok) return Response.json({ ok: false, status: "SECURITY_SIGNAL_PERSIST_FAILED" }, { status: 502 });
  return Response.json({ ok: true, status: "SECURITY_SIGNAL_RECORDED" }, { status: 201 });
}
