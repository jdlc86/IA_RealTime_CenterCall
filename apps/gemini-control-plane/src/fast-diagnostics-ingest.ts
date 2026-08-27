type FastDiagnosticEvent = Readonly<{
  event_id: string;
  occurred_at: string;
  call_id: string;
  call_control_id: string;
  tenant_id: string;
  plane: "media_edge" | "provider";
  component: string;
  stage: string;
  severity: "info" | "error";
  error_code: string | null;
  sequence: number | null;
  causal_parent_event_id: string | null;
  response_id: string | null;
  item_id: string | null;
  stream_id: string | null;
  elapsed_ms: number | null;
  duration_ms: number | null;
  audio_duration_ms: number | null;
  chunk_count: number | null;
  sample_count: number | null;
  details: Readonly<Record<string, unknown>>;
}>;

export type FastDiagnosticIngestEnv = Readonly<{
  GEMINI_MEDIA_CONTROL_PLANE_TOKEN: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FastDiagnosticIngestDependencies = Readonly<{
  fetcher?: FetchLike;
  now?: () => Date;
}>;

const MAX_EVENTS = 64;
const MAX_BODY_BYTES = 256_000;

function required(value: unknown, field: string, max = 8_192): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function nullableString(value: unknown, field: string, max = 512): string | null {
  if (value === null || value === undefined) return null;
  return required(value, field, max);
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} is invalid`);
  return Number(value);
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

function canonicalEvent(value: unknown): FastDiagnosticEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("diagnostic event is invalid");
  const input = value as Record<string, unknown>;
  const plane = required(input.plane, "diagnostic plane", 32);
  if (plane !== "media_edge" && plane !== "provider") throw new Error("diagnostic plane is invalid");
  const severity = required(input.severity, "diagnostic severity", 16);
  if (severity !== "info" && severity !== "error") throw new Error("diagnostic severity is invalid");
  const details = input.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) throw new Error("diagnostic details are invalid");
  const occurredAt = required(input.occurred_at, "diagnostic occurred_at", 64);
  if (!Number.isFinite(Date.parse(occurredAt))) throw new Error("diagnostic occurred_at is invalid");
  return Object.freeze({
    event_id: required(input.event_id, "diagnostic event_id", 512),
    occurred_at: occurredAt,
    call_id: required(input.call_id, "diagnostic call_id", 512),
    call_control_id: required(input.call_control_id, "diagnostic call_control_id", 512),
    tenant_id: required(input.tenant_id, "diagnostic tenant_id", 512),
    plane,
    component: required(input.component, "diagnostic component", 128),
    stage: required(input.stage, "diagnostic stage", 128),
    severity,
    error_code: nullableString(input.error_code, "diagnostic error_code", 128),
    sequence: nullableInteger(input.sequence, "diagnostic sequence"),
    causal_parent_event_id: nullableString(input.causal_parent_event_id, "diagnostic causal_parent_event_id", 512),
    response_id: nullableString(input.response_id, "diagnostic response_id", 512),
    item_id: nullableString(input.item_id, "diagnostic item_id", 512),
    stream_id: nullableString(input.stream_id, "diagnostic stream_id", 512),
    elapsed_ms: nullableInteger(input.elapsed_ms, "diagnostic elapsed_ms"),
    duration_ms: nullableInteger(input.duration_ms, "diagnostic duration_ms"),
    audio_duration_ms: nullableInteger(input.audio_duration_ms, "diagnostic audio_duration_ms"),
    chunk_count: nullableInteger(input.chunk_count, "diagnostic chunk_count"),
    sample_count: nullableInteger(input.sample_count, "diagnostic sample_count"),
    details: Object.freeze({ ...(details as Record<string, unknown>) }),
  });
}

function persistenceRows(events: readonly FastDiagnosticEvent[], persistedAt: string) {
  return events.map((event) => ({
    ...event,
    event: "fast_cross_plane_diagnostic",
    persisted_at: persistedAt,
  }));
}

export async function routeFastDiagnosticIngest(
  request: Request,
  env: FastDiagnosticIngestEnv,
  dependencies: FastDiagnosticIngestDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  let controlToken: string;
  try { controlToken = required(env.GEMINI_MEDIA_CONTROL_PLANE_TOKEN, "GEMINI_MEDIA_CONTROL_PLANE_TOKEN"); }
  catch { return Response.json({ ok: false, status: "DIAGNOSTICS_UNAVAILABLE" }, { status: 503 }); }
  if (!await authorized(request, controlToken)) return Response.json({ ok: false, status: "UNAUTHORIZED" }, { status: 401 });

  let supabaseUrl: string;
  let serviceRoleKey: string;
  try {
    supabaseUrl = canonicalSupabaseUrl(env.SUPABASE_URL);
    serviceRoleKey = required(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY", 16_384);
  } catch {
    return Response.json({ ok: false, status: "DIAGNOSTICS_NOT_CONFIGURED" }, { status: 503 });
  }

  let text: string;
  try {
    text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("diagnostic payload too large");
  } catch {
    return Response.json({ ok: false, status: "INVALID_DIAGNOSTICS" }, { status: 400 });
  }

  let events: readonly FastDiagnosticEvent[];
  try {
    const parsed = JSON.parse(text) as { events?: unknown };
    if (!Array.isArray(parsed?.events) || parsed.events.length < 1 || parsed.events.length > MAX_EVENTS) throw new Error("diagnostic events are invalid");
    events = parsed.events.map(canonicalEvent);
    const callIds = new Set(events.map((event) => event.call_control_id));
    const tenants = new Set(events.map((event) => event.tenant_id));
    if (callIds.size !== 1 || tenants.size !== 1) throw new Error("diagnostic batch crosses call boundary");
  } catch {
    return Response.json({ ok: false, status: "INVALID_DIAGNOSTICS" }, { status: 400 });
  }

  const fetcher = dependencies.fetcher ?? fetch;
  const persistedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const response = await fetcher(`${supabaseUrl}/rest/v1/call_diagnostic_events?on_conflict=event_id`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "content-type": "application/json",
      // Diagnostic events are immutable. Retries must not require UPDATE privilege or mutate an existing event.
      prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(persistenceRows(events, persistedAt)),
  });
  if (!response.ok) return Response.json({ ok: false, status: "DIAGNOSTIC_PERSIST_FAILED" }, { status: 502 });
  return Response.json({ ok: true, status: "PERSISTED", events: events.length }, { status: 201 });
}
