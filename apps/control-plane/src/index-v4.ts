import baseHandler from "./index-v3";
import { KvTenantRepository, type TenantKvNamespace, type TenantResolutionV1 } from "./tenant-kv";
import { buildTrustedCallerTransferHeaders, normalizeTrustedCallerNumber } from "./trusted-caller-propagation";
import { CallerSecurityService } from "./caller-security";
import { decodeHumanHandoffClientState } from "./human-handoff";
export { CallSession } from "./call-session-v13";

type WorkerEnv = {
  ENVIRONMENT: string;
  TENANT_CONFIG: TenantKvNamespace;
  OPENAI_PROJECT_ID: string;
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  CALL_SESSIONS: DurableObjectNamespace;
};

type TelnyxVoiceEvent = {
  data?: {
    id?: string;
    event_type?: string;
    payload?: {
      call_control_id?: string;
      call_leg_id?: string;
      call_session_id?: string;
      direction?: string;
      state?: string;
      from?: string;
      to?: string;
      hangup_cause?: string;
      hangup_source?: string;
      client_state?: string;
    };
  };
};

function json(body: unknown, status = 200): Response { return Response.json(body, { status }); }
function requireEnvString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`); return value.trim(); }
function decodeBase64(value: string): Uint8Array { const binary = atob(value.replace(/\s+/g, "")); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); return bytes; }
function decodeTelnyxPublicKey(value: string): { format: "raw" | "spki"; bytes: Uint8Array } { const trimmed = requireEnvString(value, "TELNYX_PUBLIC_KEY"); if (trimmed.includes("BEGIN PUBLIC KEY")) { const base64 = trimmed.replace(/-----BEGIN PUBLIC KEY-----/g, "").replace(/-----END PUBLIC KEY-----/g, "").replace(/\s+/g, ""); return { format: "spki", bytes: decodeBase64(base64) }; } const bytes = decodeBase64(trimmed); return bytes.byteLength === 32 ? { format: "raw", bytes } : { format: "spki", bytes }; }
async function verifyTelnyxSignature(rawBody: string, request: Request, publicKeyValue: string): Promise<boolean> { const signature = request.headers.get("telnyx-signature-ed25519"); const timestamp = request.headers.get("telnyx-timestamp"); if (!signature || !timestamp) return false; const timestampSeconds = Number(timestamp); if (!Number.isFinite(timestampSeconds)) return false; if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 300) return false; const decoded = decodeTelnyxPublicKey(publicKeyValue); const key = await crypto.subtle.importKey(decoded.format, decoded.bytes, { name: "Ed25519" }, false, ["verify"]); return crypto.subtle.verify("Ed25519", key, decodeBase64(signature), new TextEncoder().encode(`${timestamp}|${rawBody}`)); }
function buildOpenAISipUri(env: WorkerEnv): string { return `sip:${requireEnvString(env.OPENAI_PROJECT_ID, "OPENAI_PROJECT_ID")}@sip.api.openai.com;transport=tls`; }

async function transferToRealtime(callControlId: string, eventId: string, resolution: TenantResolutionV1, callerPhone: string, env: WorkerEnv): Promise<void> {
  const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`, { method: "POST", headers: { Authorization: `Bearer ${requireEnvString(env.TELNYX_API_KEY, "TELNYX_API_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify({ to: buildOpenAISipUri(env), from: callerPhone, sip_transport_protocol: "TLS", timeout_secs: 30, command_id: eventId, custom_headers: buildTrustedCallerTransferHeaders(callerPhone, resolution.tenantId, resolution.calledNumber, resolution.source, callControlId) }) });
  if (!response.ok) { const body = await response.text(); console.error(JSON.stringify({ level: "error", event: "telnyx_transfer_with_caller_failed", tenant_id: resolution.tenantId, status: response.status, response: body.slice(0, 1000) })); throw new Error(`Telnyx transfer failed with HTTP ${response.status}`); }
}

async function rejectSecurityBlockedCall(callControlId: string, eventId: string, env: WorkerEnv): Promise<void> {
  const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/reject`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnvString(env.TELNYX_API_KEY, "TELNYX_API_KEY")}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ cause: "CALL_REJECTED", command_id: `${eventId}-security-reject` }),
  });
  if (!response.ok) {
    const body = await response.text();
    console.error(JSON.stringify({ level: "error", event: "telnyx_security_reject_failed", status: response.status, response: body.slice(0, 500) }));
    throw new Error(`Telnyx reject failed with HTTP ${response.status}`);
  }
}

async function forwardHumanHandoffEvent(env: WorkerEnv, event: TelnyxVoiceEvent): Promise<void> {
  const payload = event.data?.payload;
  const state = decodeHumanHandoffClientState(payload?.client_state);
  if (!state) return;
  if (!env.CALL_SESSIONS || typeof env.CALL_SESSIONS.idFromName !== "function") throw new Error("CALL_SESSIONS binding unavailable");
  const stub = env.CALL_SESSIONS.get(env.CALL_SESSIONS.idFromName(state.realtimeCallId));
  const response = await stub.fetch("https://call-session.internal/human-handoff/telnyx-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      handoff_id: state.handoffId,
      realtime_call_id: state.realtimeCallId,
      tenant_id: state.tenantId,
      source_call_control_id: state.sourceCallControlId,
      event_id: event.data?.id ?? null,
      event_type: event.data?.event_type ?? "unknown",
      call_control_id: payload?.call_control_id ?? null,
      call_leg_id: payload?.call_leg_id ?? null,
      call_session_id: payload?.call_session_id ?? null,
      direction: payload?.direction ?? null,
      state: payload?.state ?? null,
      hangup_cause: payload?.hangup_cause ?? null,
      hangup_source: payload?.hangup_source ?? null,
    }),
  });
  if (!response.ok) throw new Error(`Human handoff event forwarding failed with HTTP ${response.status}`);
}

async function handleTelnyxWebhook(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const rawBody = await request.text();
  const valid = await verifyTelnyxSignature(rawBody, request, requireEnvString(env.TELNYX_PUBLIC_KEY, "TELNYX_PUBLIC_KEY"));
  if (!valid) return json({ ok: false, error: "invalid_webhook_signature" }, 403);
  let event: TelnyxVoiceEvent; try { event = JSON.parse(rawBody) as TelnyxVoiceEvent; } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const eventType = event.data?.event_type ?? "unknown"; const payload = event.data?.payload;

  const handoffState = decodeHumanHandoffClientState(payload?.client_state);
  if (handoffState) {
    ctx.waitUntil(forwardHumanHandoffEvent(env, event).catch((error) => console.error(JSON.stringify({ level: "error", event: "human_handoff_webhook_forward_failed", handoff_id: handoffState.handoffId, error: error instanceof Error ? error.message : String(error) }))));
    return json({ ok: true, accepted: true, action: "human_handoff_event_forwarded", event_type: eventType, handoff_id: handoffState.handoffId });
  }

  if (eventType !== "call.initiated" || payload?.direction !== "incoming") return json({ ok: true, ignored: true, event_type: eventType });
  const callControlId = payload.call_control_id?.trim(); const calledNumber = payload.to?.trim();
  if (!callControlId) return json({ ok: false, error: "missing_call_control_id" }, 400);
  if (!calledNumber) return json({ ok: false, error: "missing_called_number" }, 400);
  const callerPhone = normalizeTrustedCallerNumber(payload.from, calledNumber);
  if (!callerPhone) { console.error(JSON.stringify({ level: "error", event: "trusted_caller_number_missing", called_number: calledNumber })); return json({ ok: false, error: "missing_trusted_caller_number" }, 409); }
  const repository = new KvTenantRepository(env.TENANT_CONFIG); let resolution: TenantResolutionV1 | null;
  try { resolution = await repository.resolveByCalledNumber(calledNumber); } catch { return json({ ok: false, error: "tenant_kv_configuration_invalid" }, 500); }
  if (!resolution) return json({ ok: false, error: "tenant_not_found" }, 404);

  const eventId = event.data?.id ?? crypto.randomUUID();
  try {
    const security = new CallerSecurityService({ SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY });
    const decision = await security.evaluateInbound(resolution.tenantId, callerPhone);
    console.log(JSON.stringify({
      level: decision.decision === "BLOCK" ? "warn" : "info",
      event: "caller_security_inbound_evaluated",
      tenant_id: resolution.tenantId,
      decision: decision.decision,
      reason: decision.reason,
      calls_1m: decision.calls_1m,
      calls_5m: decision.calls_5m,
      calls_1h: decision.calls_1h,
      risk_score: decision.risk_score,
      security_strikes: decision.security_strikes,
      rate_limit_blocks: decision.rate_limit_blocks,
      permanent_block: decision.permanent_block,
      blocked_until: decision.blocked_until,
    }));
    if (decision.decision === "BLOCK") {
      ctx.waitUntil(rejectSecurityBlockedCall(callControlId, eventId, env));
      return json({ ok: true, accepted: false, action: "security_reject", reason: decision.reason, blocked_until: decision.blocked_until, permanent_block: decision.permanent_block });
    }
  } catch (error) {
    // Availability of the security store must not become a global denial-of-service vector.
    // Fail open for this call, but emit a high visibility event for operations.
    console.error(JSON.stringify({ level: "error", event: "caller_security_inbound_check_failed_open", tenant_id: resolution.tenantId, error: error instanceof Error ? error.message : String(error) }));
  }

  ctx.waitUntil(transferToRealtime(callControlId, eventId, resolution, callerPhone, env));
  return json({ ok: true, accepted: true, action: "transfer_to_realtime", tenant_id: resolution.tenantId, called_number: resolution.calledNumber, caller_number_propagated: true, caller_security_checked: true, telnyx_call_control_id_propagated: true });
}

export default { async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> { const url = new URL(request.url); if (request.method === "POST" && url.pathname === "/webhooks/telnyx") return handleTelnyxWebhook(request, env, ctx); return baseHandler.fetch(request, env as never, ctx); } } satisfies ExportedHandler<WorkerEnv>;
