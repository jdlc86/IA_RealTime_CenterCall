export type FastCallerSecurityEnv = Readonly<{
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CALLER_SECURITY_HMAC_SECRET?: string;
  GEMINI_CALLER_SECURITY_SIGNALS?: Queue<QueuedFastCallerSecuritySignal>;
}>;

export type QueuedFastCallerSecuritySignal = Readonly<{
  eventKey: string;
  tenantId: string;
  callerKey: string;
  eventType: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskDelta: number;
  highConfidence: boolean;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type FastCallerSecurityDelivery = Readonly<{
  delivery: "DIRECT" | "QUEUED";
}>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function required(value: unknown, field: string, max = 16_384): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function canonicalSupabaseUrl(value: unknown): string {
  const parsed = new URL(required(value, "SUPABASE_URL", 2_048));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("SUPABASE_URL is invalid");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function isQueuedFastCallerSecuritySignal(value: unknown): value is QueuedFastCallerSecuritySignal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<QueuedFastCallerSecuritySignal>;
  return typeof item.eventKey === "string" && Boolean(item.eventKey.trim())
    && typeof item.tenantId === "string" && Boolean(item.tenantId.trim())
    && typeof item.callerKey === "string" && /^[a-f0-9]{64}$/.test(item.callerKey)
    && typeof item.eventType === "string" && Boolean(item.eventType.trim())
    && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(item.severity ?? "")
    && typeof item.riskDelta === "number" && Number.isInteger(item.riskDelta) && item.riskDelta >= 0 && item.riskDelta <= 100
    && typeof item.highConfidence === "boolean"
    && Boolean(item.metadata) && typeof item.metadata === "object" && !Array.isArray(item.metadata);
}

export async function fastCallerKey(env: FastCallerSecurityEnv, tenantId: string, callerPhone: string): Promise<string> {
  // This must contain the exact historical caller-HMAC bytes. It is intentionally
  // independent from the Supabase API credential so a credential rotation cannot
  // reset or fork caller reputation.
  const secret = required(env.CALLER_SECURITY_HMAC_SECRET, "CALLER_SECURITY_HMAC_SECRET");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${tenantId}|${callerPhone}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function persistFastCallerSecuritySignal(
  env: FastCallerSecurityEnv,
  signal: QueuedFastCallerSecuritySignal,
  fetcher: FetchLike = fetch,
): Promise<void> {
  const baseUrl = canonicalSupabaseUrl(env.SUPABASE_URL);
  const serviceRoleKey = required(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetcher(`${baseUrl}/rest/v1/rpc/record_caller_security_signal_v2`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      p_event_key: signal.eventKey,
      p_tenant_id: signal.tenantId,
      p_caller_key: signal.callerKey,
      p_event_type: signal.eventType,
      p_severity: signal.severity,
      p_risk_delta: signal.riskDelta,
      p_metadata: signal.metadata,
      p_high_confidence: signal.highConfidence,
    }),
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`record_caller_security_signal_v2 failed with HTTP ${response.status}`);
}

export async function recordFastCallerSecuritySignalDurably(
  env: FastCallerSecurityEnv,
  input: Omit<QueuedFastCallerSecuritySignal, "callerKey"> & { callerPhone: string },
  fetcher: FetchLike = fetch,
): Promise<FastCallerSecurityDelivery> {
  const queuedSignal: QueuedFastCallerSecuritySignal = Object.freeze({
    eventKey: input.eventKey,
    tenantId: input.tenantId,
    callerKey: await fastCallerKey(env, input.tenantId, input.callerPhone),
    eventType: input.eventType,
    severity: input.severity,
    riskDelta: input.riskDelta,
    highConfidence: input.highConfidence,
    metadata: input.metadata,
  });
  const queue = env.GEMINI_CALLER_SECURITY_SIGNALS;
  if (queue && typeof queue.send === "function") {
    try {
      // A successful send is the durable handoff. Queue-first keeps Supabase
      // latency and retries outside the discrete tool response path.
      await queue.send(queuedSignal, { contentType: "json" });
      return { delivery: "QUEUED" };
    } catch {
      // Fall through to direct idempotent persistence if Queue is unavailable.
    }
  }
  await persistFastCallerSecuritySignal(env, queuedSignal, fetcher);
  return { delivery: "DIRECT" };
}
