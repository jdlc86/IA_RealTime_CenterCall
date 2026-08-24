import baseHandler from "./index-v6-runtime-core.js";
import { CallerSecurityService, type QueuedCallerSecuritySignal } from "./caller-security.js";
import {
  callDiagnosticPersistencePortForEnv,
  type CrossPlaneDiagnosticEvent,
} from "./call-diagnostic-persistence-port.js";

// Keep the CallSession runtime chain capped at V54. This entrypoint only adds
// cross-plane observability around the existing Worker handler.
export { CallSession } from "./call-session-v54-close-confirmation-authority";

type WorkerEnv = Env & {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  CALLER_SECURITY_SIGNALS: Queue<QueuedCallerSecuritySignal>;
  GEMINI_MEDIA_EDGE_URL?: string;
  MEDIA_EDGE_CONTROL_PLANE_TOKEN?: string;
};

type ObservedTelnyxEvent = Readonly<{
  eventId: string;
  occurredAt: string | null;
  eventType: string;
  callControlId: string;
  direction: string | null;
}>;

type GeminiAdmissionResponse = Readonly<{
  action?: unknown;
  tenant_id?: unknown;
  realtime_provider?: unknown;
  realtime_provider_source?: unknown;
  traffic_admission_scope?: unknown;
  caller_security_checked?: unknown;
  sideband_ready_before_streaming?: unknown;
  streaming_start_final_effect?: unknown;
  fallback_provider_used?: unknown;
}>;

function isQueuedSecuritySignal(value: unknown): value is QueuedCallerSecuritySignal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<QueuedCallerSecuritySignal>;
  return typeof item.eventKey === "string" && Boolean(item.eventKey.trim())
    && typeof item.tenantId === "string" && Boolean(item.tenantId.trim())
    && typeof item.callerKey === "string" && Boolean(item.callerKey.trim())
    && typeof item.eventType === "string" && Boolean(item.eventType.trim())
    && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(item.severity ?? "")
    && typeof item.riskDelta === "number" && Number.isInteger(item.riskDelta) && item.riskDelta >= 0
    && typeof item.highConfidence === "boolean"
    && (item.metadata === undefined || (Boolean(item.metadata) && typeof item.metadata === "object" && !Array.isArray(item.metadata)));
}

async function consumeSecuritySignals(batch: MessageBatch<QueuedCallerSecuritySignal>, env: WorkerEnv): Promise<void> {
  const security = new CallerSecurityService(env);
  await Promise.all(batch.messages.map(async (message) => {
    if (!isQueuedSecuritySignal(message.body)) {
      console.error(JSON.stringify({ level: "error", event: "caller_security_signal_queue_invalid", queue_message_id: message.id }));
      message.ack();
      return;
    }
    try {
      await security.recordSignalByCallerKey(message.body);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "caller_security_signal_queue_retry",
        queue_message_id: message.id,
        event_key: message.body.eventKey,
        attempts: message.attempts,
        error: error instanceof Error ? error.message : String(error),
      }));
      message.retry();
    }
  }));
}

function requiredEnv(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

function parseTelnyxEvent(raw: string): ObservedTelnyxEvent | null {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as { id?: unknown; occurred_at?: unknown; event_type?: unknown; payload?: unknown };
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as { call_control_id?: unknown; direction?: unknown };
  if (typeof record.id !== "string" || !record.id.trim()) return null;
  if (typeof record.event_type !== "string" || !record.event_type.trim()) return null;
  if (typeof body.call_control_id !== "string" || !body.call_control_id.trim()) return null;
  return Object.freeze({
    eventId: record.id.trim(),
    occurredAt: typeof record.occurred_at === "string" && Number.isFinite(Date.parse(record.occurred_at))
      ? new Date(record.occurred_at).toISOString()
      : null,
    eventType: record.event_type.trim(),
    callControlId: body.call_control_id.trim(),
    direction: typeof body.direction === "string" && body.direction.trim() ? body.direction.trim() : null,
  });
}

async function responseJson(response: Response): Promise<GeminiAdmissionResponse | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  try {
    const value = await response.clone().json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as GeminiAdmissionResponse
      : null;
  } catch {
    return null;
  }
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function workerAdmissionEvent(
  observed: ObservedTelnyxEvent,
  response: GeminiAdmissionResponse,
  durationMs: number,
): CrossPlaneDiagnosticEvent | null {
  if (response.action !== "start_gemini_media_stream" || response.realtime_provider !== "GEMINI") return null;
  const tenantId = safeString(response.tenant_id);
  if (!tenantId) return null;
  const now = new Date().toISOString();
  return Object.freeze({
    event_id: `${observed.eventId}:worker:gemini-admission-completed`,
    occurred_at: now,
    call_id: observed.callControlId,
    call_control_id: observed.callControlId,
    tenant_id: tenantId,
    plane: "worker",
    component: "control-plane-worker",
    stage: "GEMINI_ADMISSION_COMPLETED",
    severity: "info",
    sequence: 1,
    duration_ms: Math.max(0, Math.min(3_600_000, Math.trunc(durationMs))),
    details: {
      provider: "GEMINI",
      provider_source: safeString(response.realtime_provider_source) ?? "UNKNOWN",
      traffic_admission_scope: safeString(response.traffic_admission_scope) ?? "UNKNOWN",
      webhook_signature_verified: true,
      caller_security_checked: response.caller_security_checked === true,
      sideband_ready_before_streaming: response.sideband_ready_before_streaming === true,
      streaming_start_final_effect: response.streaming_start_final_effect === true,
      fallback_provider_used: response.fallback_provider_used === true,
    },
  });
}

function workerHangupEvent(observed: ObservedTelnyxEvent): CrossPlaneDiagnosticEvent {
  return Object.freeze({
    event_id: `${observed.eventId}:worker:telnyx-hangup-observed`,
    occurred_at: observed.occurredAt ?? new Date().toISOString(),
    call_id: observed.callControlId,
    call_control_id: observed.callControlId,
    tenant_id: null,
    plane: "worker",
    component: "control-plane-worker",
    stage: "TELNYX_HANGUP_OBSERVED",
    severity: "info",
    sequence: 2,
    details: { webhook_signature_verified: true },
  });
}

function mediaDiagnosticEndpoint(edgeValue: unknown, callControlId: string): string {
  const raw = requiredEnv(edgeValue, "GEMINI_MEDIA_EDGE_URL");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("GEMINI_MEDIA_EDGE_URL is invalid"); }
  if (url.protocol !== "wss:") throw new Error("GEMINI_MEDIA_EDGE_URL must use wss://");
  url.protocol = "https:";
  url.pathname = "/internal/diagnostics";
  url.search = "";
  url.searchParams.set("call_control_id", callControlId);
  url.hash = "";
  return url.toString();
}

async function pullAndPersistMediaEdgeDiagnostics(env: WorkerEnv, observed: ObservedTelnyxEvent): Promise<void> {
  const token = requiredEnv(env.MEDIA_EDGE_CONTROL_PLANE_TOKEN, "MEDIA_EDGE_CONTROL_PLANE_TOKEN");
  const response = await fetch(mediaDiagnosticEndpoint(env.GEMINI_MEDIA_EDGE_URL, observed.callControlId), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Media Edge diagnostics pull failed with HTTP ${response.status}`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("Media Edge diagnostics pull returned invalid JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Media Edge diagnostics pull returned invalid payload");
  const events = (payload as { events?: unknown }).events;
  if (!Array.isArray(events)) throw new Error("Media Edge diagnostics pull omitted events");
  const port = callDiagnosticPersistencePortForEnv(env);
  await port.writeCrossPlaneBatch([workerHangupEvent(observed), ...events]);
  console.log(JSON.stringify({
    level: "info",
    event: "media_edge_diagnostics_persisted",
    call_control_id: observed.callControlId,
    event_count: events.length,
  }));
}

function reportBackgroundFailure(event: string, observed: ObservedTelnyxEvent, error: unknown): void {
  console.error(JSON.stringify({
    level: "error",
    event,
    call_control_id: observed.callControlId,
    error_code: error instanceof Error && /HTTP\s+(\d{3})/.test(error.message)
      ? `HTTP_${error.message.match(/HTTP\s+(\d{3})/)?.[1] ?? "ERROR"}`
      : "DIAGNOSTIC_BACKGROUND_FAILURE",
  }));
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    if (!baseHandler.fetch) return new Response("Worker fetch handler unavailable", { status: 503 });
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/webhooks/telnyx") {
      return baseHandler.fetch(request, env as never, ctx);
    }

    const rawPromise = request.clone().text().catch(() => "");
    const startedAt = Date.now();
    const response = await baseHandler.fetch(request, env as never, ctx);
    const raw = await rawPromise;
    const observed = parseTelnyxEvent(raw);
    if (!observed || !response.ok) return response;

    if (observed.eventType === "call.initiated" && observed.direction === "incoming") {
      const body = await responseJson(response);
      const event = body ? workerAdmissionEvent(observed, body, Date.now() - startedAt) : null;
      if (event) {
        ctx.waitUntil(
          callDiagnosticPersistencePortForEnv(env).writeCrossPlaneBatch([event]).catch((error) => {
            reportBackgroundFailure("worker_admission_diagnostic_persist_failed", observed, error);
          }),
        );
      }
    }

    if (observed.eventType === "call.hangup") {
      ctx.waitUntil(
        pullAndPersistMediaEdgeDiagnostics(env, observed).catch((error) => {
          reportBackgroundFailure("media_edge_diagnostics_pull_failed", observed, error);
        }),
      );
    }
    return response;
  },

  queue: consumeSecuritySignals,
} satisfies ExportedHandler<WorkerEnv, QueuedCallerSecuritySignal>;
