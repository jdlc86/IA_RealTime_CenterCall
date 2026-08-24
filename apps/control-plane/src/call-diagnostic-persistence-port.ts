import { SupabaseAdapter, type CallDiagnosticEvent } from "./supabase-adapter.js";

export type { CallDiagnosticEvent } from "./supabase-adapter.js";

export type CrossPlaneDiagnosticEvent = Readonly<{
  event_id: string;
  occurred_at: string;
  call_id: string;
  call_control_id: string;
  tenant_id: string | null;
  plane: "worker" | "call_session" | "media_edge" | "provider";
  component: string;
  stage: string;
  severity: "info" | "error";
  error_code?: string | null;
  sequence?: number | null;
  causal_parent_event_id?: string | null;
  response_id?: string | null;
  item_id?: string | null;
  stream_id?: string | null;
  elapsed_ms?: number | null;
  duration_ms?: number | null;
  audio_duration_ms?: number | null;
  chunk_count?: number | null;
  sample_count?: number | null;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type CallDiagnosticPersistencePort = Readonly<{
  write(event: CallDiagnosticEvent): Promise<void>;
  writeCrossPlaneBatch(events: readonly unknown[]): Promise<number>;
}>;

type CallDiagnosticPersistenceHost = object;
type PersistenceEnv = object;

const ALLOWED_PLANES = new Set(["worker", "call_session", "media_edge", "provider"]);
const SAFE_DETAIL_KEYS = new Set([
  "phase",
  "reason",
  "kind",
  "type",
  "provider",
  "provider_source",
  "traffic_admission_scope",
  "webhook_signature_verified",
  "caller_security_checked",
  "sideband_ready_before_streaming",
  "streaming_start_final_effect",
  "fallback_provider_used",
  "inbound_answer_before_streaming",
  "setup_sent",
  "setup_complete",
  "authorized",
  "started",
  "input_detection_enabled",
  "rms",
  "noise_floor_rms",
  "effective_stop_rms",
  "provider_error_code",
  "close_code",
  "http_status",
]);
const FORBIDDEN_KEY_PARTS = [
  "transcript",
  "audio",
  "payload",
  "secret",
  "token",
  "authorization",
  "credential",
  "prompt",
  "instruction",
  "phone",
  "name",
  "email",
  "address",
  "reservation",
];

function requiredConfig(env: PersistenceEnv, name: "SUPABASE_URL" | "SUPABASE_SECRET_KEY"): string {
  const value = (env as Record<string, unknown>)[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

function requiredString(value: unknown, field: string, maxLength: number, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid cross-plane diagnostic ${field}`);
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\r\n\t]/.test(normalized) || (pattern && !pattern.test(normalized))) {
    throw new Error(`Invalid cross-plane diagnostic ${field}`);
  }
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number, pattern?: RegExp): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, field, maxLength, pattern);
}

function boundedInteger(value: unknown, field: string, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`Invalid cross-plane diagnostic ${field}`);
  }
  return value;
}

function normalizeOccurredAt(value: unknown): string {
  const raw = requiredString(value, "occurred_at", 64);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error("Invalid cross-plane diagnostic occurred_at");
  return new Date(parsed).toISOString();
}

function safeDetails(value: unknown): Record<string, string | number | boolean | null> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cross-plane diagnostic details");
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, detail] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.trim().toLowerCase();
    if (FORBIDDEN_KEY_PARTS.some((part) => normalizedKey.includes(part))) {
      throw new Error("Cross-plane diagnostic details contain a forbidden field");
    }
    if (!SAFE_DETAIL_KEYS.has(normalizedKey)) continue;
    if (detail === null || typeof detail === "boolean") {
      result[normalizedKey] = detail;
      continue;
    }
    if (typeof detail === "number") {
      if (!Number.isFinite(detail) || Math.abs(detail) > 1_000_000_000) throw new Error("Invalid cross-plane diagnostic numeric detail");
      result[normalizedKey] = detail;
      continue;
    }
    if (typeof detail === "string") {
      const text = detail.trim();
      if (!text || text.length > 128 || !/^[A-Za-z0-9_.:+-]+$/.test(text)) {
        throw new Error("Invalid cross-plane diagnostic string detail");
      }
      result[normalizedKey] = text;
      continue;
    }
    throw new Error("Invalid cross-plane diagnostic detail value");
  }
  return result;
}

export function normalizeCrossPlaneDiagnosticEvent(value: unknown): CrossPlaneDiagnosticEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cross-plane diagnostic event");
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_KEY_PARTS.some((part) => lower.includes(part))) {
      throw new Error("Cross-plane diagnostic event contains a forbidden field");
    }
  }
  const plane = requiredString(source.plane, "plane", 32, /^[a-z_]+$/);
  if (!ALLOWED_PLANES.has(plane)) throw new Error("Invalid cross-plane diagnostic plane");
  const severity = requiredString(source.severity, "severity", 16, /^[a-z]+$/);
  if (severity !== "info" && severity !== "error") throw new Error("Invalid cross-plane diagnostic severity");
  const tenantId = optionalString(source.tenant_id, "tenant_id", 128, /^[a-z0-9][a-z0-9-]{1,127}$/);
  const sequence = boundedInteger(source.sequence, "sequence", 1_000_000);
  if (sequence === 0) throw new Error("Invalid cross-plane diagnostic sequence");
  return Object.freeze({
    event_id: requiredString(source.event_id, "event_id", 768, /^\S+$/),
    occurred_at: normalizeOccurredAt(source.occurred_at),
    call_id: requiredString(source.call_id, "call_id", 512, /^\S+$/),
    call_control_id: requiredString(source.call_control_id, "call_control_id", 512, /^\S+$/),
    tenant_id: tenantId,
    plane: plane as CrossPlaneDiagnosticEvent["plane"],
    component: requiredString(source.component, "component", 96, /^[A-Za-z0-9_.:-]+$/),
    stage: requiredString(source.stage, "stage", 128, /^[A-Z0-9_]+$/),
    severity: severity as CrossPlaneDiagnosticEvent["severity"],
    error_code: optionalString(source.error_code, "error_code", 96, /^[A-Z0-9_]+$/),
    sequence,
    causal_parent_event_id: optionalString(source.causal_parent_event_id, "causal_parent_event_id", 768, /^\S+$/),
    response_id: optionalString(source.response_id, "response_id", 512, /^\S+$/),
    item_id: optionalString(source.item_id, "item_id", 512, /^\S+$/),
    stream_id: optionalString(source.stream_id, "stream_id", 512, /^\S+$/),
    elapsed_ms: boundedInteger(source.elapsed_ms, "elapsed_ms", 3_600_000),
    duration_ms: boundedInteger(source.duration_ms, "duration_ms", 3_600_000),
    audio_duration_ms: boundedInteger(source.audio_duration_ms, "audio_duration_ms", 3_600_000),
    chunk_count: boundedInteger(source.chunk_count, "chunk_count", 100_000),
    sample_count: boundedInteger(source.sample_count, "sample_count", 57_600_000),
    details: Object.freeze(safeDetails(source.details)),
  });
}

const hostPorts = new WeakMap<object, CallDiagnosticPersistencePort>();
const envPorts = new WeakMap<object, CallDiagnosticPersistencePort>();

function createPort(env: PersistenceEnv): CallDiagnosticPersistencePort {
  const baseUrl = requiredConfig(env, "SUPABASE_URL").replace(/\/+$/, "");
  const secretKey = requiredConfig(env, "SUPABASE_SECRET_KEY");
  const adapter = new SupabaseAdapter({ SUPABASE_URL: baseUrl, SUPABASE_SECRET_KEY: secretKey });
  return Object.freeze({
    write: (event: CallDiagnosticEvent) => adapter.writeDiagnosticEvent(event),
    async writeCrossPlaneBatch(values: readonly unknown[]): Promise<number> {
      if (values.length === 0) return 0;
      if (values.length > 512) throw new Error("Cross-plane diagnostic batch exceeds 512 events");
      const events = values.map(normalizeCrossPlaneDiagnosticEvent);
      const params = new URLSearchParams({ on_conflict: "event_id" });
      const response = await fetch(`${baseUrl}/rest/v1/call_diagnostic_events?${params.toString()}`, {
        method: "POST",
        headers: {
          apikey: secretKey,
          "Content-Type": "application/json",
          Accept: "application/json",
          Prefer: "resolution=ignore-duplicates,return=minimal",
        },
        body: JSON.stringify(events.map((event) => ({
          event_id: event.event_id,
          occurred_at: event.occurred_at,
          call_id: event.call_id,
          call_control_id: event.call_control_id,
          tenant_id: event.tenant_id,
          plane: event.plane,
          component: event.component,
          stage: event.stage,
          event: "cross_plane_diagnostic",
          severity: event.severity,
          error_code: event.error_code ?? null,
          sequence: event.sequence ?? null,
          causal_parent_event_id: event.causal_parent_event_id ?? null,
          response_id: event.response_id ?? null,
          item_id: event.item_id ?? null,
          stream_id: event.stream_id ?? null,
          elapsed_ms: event.elapsed_ms ?? null,
          duration_ms: event.duration_ms ?? null,
          audio_duration_ms: event.audio_duration_ms ?? null,
          chunk_count: event.chunk_count ?? null,
          sample_count: event.sample_count ?? null,
          details: event.details ?? {},
        }))),
      });
      if (!response.ok) throw new Error(`Supabase cross-plane diagnostics write failed with HTTP ${response.status}`);
      return events.length;
    },
  });
}

/** Provider composition edge for durable CallSession diagnostics. */
export function callDiagnosticPersistencePortFor(host: CallDiagnosticPersistenceHost): CallDiagnosticPersistencePort {
  let port = hostPorts.get(host);
  if (!port) {
    const env = (host as { env?: object }).env;
    if (!env) throw new Error("Missing runtime diagnostic persistence environment");
    port = createPort(env);
    hostPorts.set(host, port);
  }
  return port;
}

/** Worker-side access to the same persistence authority used by CallSession. */
export function callDiagnosticPersistencePortForEnv(env: PersistenceEnv): CallDiagnosticPersistencePort {
  let port = envPorts.get(env);
  if (!port) {
    port = createPort(env);
    envPorts.set(env, port);
  }
  return port;
}
