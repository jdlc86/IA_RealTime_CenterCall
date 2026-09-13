import {
  recordFastCallerSecuritySignalDurably,
  type FastCallerSecurityEnv,
} from "../fast-caller-security";

type TenantKv = Readonly<{ get(key: string): Promise<string | null> }>;

export type FastSemanticSecurityTerminationEnv = FastCallerSecurityEnv & Readonly<{
  TELNYX_API_KEY?: string;
  GEMINI_MEDIA_CONTROL_PLANE_TOKEN?: string;
  TENANT_ROUTING_KV: TenantKv;
}>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Dependencies = Readonly<{
  fetcher?: FetchLike;
  recordSignal?: typeof recordFastCallerSecuritySignalDurably;
  waitUntil?: (promise: Promise<void>) => void;
}>;

const CATEGORIES = new Set([
  "PROMPT_EXFILTRATION",
  "PROMPT_INJECTION",
  "ROLE_ESCALATION",
  "TOOL_MANIPULATION",
]);

function required(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function e164(value: unknown, field: string): string {
  const normalized = required(value, field, 16);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")?.trim() ?? "");
  return Boolean(match && await secureEqual(match[1], expected));
}

async function canonicalInput(request: Request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 4_096) throw new Error("termination payload too large");
  const input = record(JSON.parse(text));
  if (!input) throw new Error("termination payload is invalid");
  const expected = ["callControlId", "calledPhoneE164", "callerPhoneE164", "category", "eventKey", "tenantId"].sort();
  const keys = Object.keys(input).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("termination fields are invalid");
  }
  const category = required(input.category, "category", 64);
  if (!CATEGORIES.has(category)) throw new Error("category is invalid");
  const callerPhoneE164 = input.callerPhoneE164 == null ? null : e164(input.callerPhoneE164, "callerPhoneE164");
  const eventKey = required(input.eventKey, "eventKey", 128);
  if (!/^gemini-fast-semsec-terminal-v1:[a-f0-9]{64}$/.test(eventKey)) throw new Error("eventKey is invalid");
  return Object.freeze({
    tenantId: required(input.tenantId, "tenantId", 256),
    callControlId: required(input.callControlId, "callControlId", 512),
    calledPhoneE164: e164(input.calledPhoneE164, "calledPhoneE164"),
    callerPhoneE164,
    category,
    eventKey,
  });
}

async function verifyTenantRoute(kv: TenantKv, tenantId: string, calledPhoneE164: string): Promise<void> {
  const raw = await kv.get(`tenant_by_phone:${calledPhoneE164}`);
  const route = raw ? record(JSON.parse(raw)) : null;
  if (!route || route.enabled !== true || required(route.tenant_id, "route tenantId", 256) !== tenantId) {
    throw new Error("tenant route mismatch");
  }
}

export async function routeFastSemanticSecurityTermination(
  request: Request,
  env: FastSemanticSecurityTerminationEnv,
  dependencies: Dependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  let token: string;
  try { token = required(env.GEMINI_MEDIA_CONTROL_PLANE_TOKEN, "GEMINI_MEDIA_CONTROL_PLANE_TOKEN", 8_192); }
  catch { return Response.json({ ok: false, status: "SECURITY_TERMINATION_UNAVAILABLE" }, { status: 503 }); }
  if (!await authorized(request, token)) return Response.json({ ok: false, status: "UNAUTHORIZED" }, { status: 401 });

  let input: Awaited<ReturnType<typeof canonicalInput>>;
  try {
    input = await canonicalInput(request);
    await verifyTenantRoute(env.TENANT_ROUTING_KV, input.tenantId, input.calledPhoneE164);
  } catch {
    return Response.json({ ok: false, status: "SECURITY_TERMINATION_REJECTED" }, { status: 403 });
  }

  const callerPhone = input.callerPhoneE164;
  let reputationSignalStatus = callerPhone ? "UNAVAILABLE" : "IDENTITY_UNAVAILABLE";
  if (callerPhone) {
    const persistReputation = async () => {
      const delivery = await (dependencies.recordSignal ?? recordFastCallerSecuritySignalDurably)(env, {
        eventKey: input.eventKey,
        tenantId: input.tenantId,
        callerPhone,
        eventType: `GEMINI_SEMANTIC_TERMINAL_${input.category}`,
        severity: "HIGH",
        riskDelta: 10,
        highConfidence: true,
        metadata: Object.freeze({
          source: "GEMINI_FAST_SEMANTIC_TERMINATION",
          category: input.category,
          observation_threshold: 3,
          raw_transcript_stored: false,
        }),
      });
      return delivery.delivery === "QUEUED" ? "QUEUED" : "RECORDED";
    };
    if (dependencies.waitUntil) {
      dependencies.waitUntil(persistReputation().then(() => undefined).catch(() => undefined));
      reputationSignalStatus = "SCHEDULED";
    } else {
      try {
        reputationSignalStatus = await persistReputation();
      } catch {
        // The terminal safety effect must not depend on telemetry availability.
      }
    }
  }

  const fetcher = dependencies.fetcher ?? fetch;
  const apiKey = (() => {
    try { return required(env.TELNYX_API_KEY, "TELNYX_API_KEY", 8_192); }
    catch { return null; }
  })();
  if (!apiKey) return Response.json({ ok: false, status: "SECURITY_TERMINATION_UNAVAILABLE" }, { status: 503 });
  const commandSuffix = input.eventKey.slice(-32);
  try {
    const response = await fetcher(`https://api.telnyx.com/v2/calls/${encodeURIComponent(input.callControlId)}/actions/hangup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ command_id: `gemini-semsec-close-${commandSuffix}` }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return Response.json({ ok: false, status: "SECURITY_TERMINATION_FAILED", reputationSignalStatus }, { status: 502 });
    }
    return Response.json({ ok: true, status: "SECURITY_CALL_TERMINATED", reputationSignalStatus }, { status: 202 });
  } catch {
    return Response.json({ ok: false, status: "SECURITY_TERMINATION_FAILED", reputationSignalStatus }, { status: 502 });
  }
}
