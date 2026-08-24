import baseHandler from "./index-v3";
import {
  KvTenantRepository,
  type TenantConfiguration,
  type TenantKvNamespace,
  type TenantResolutionV1,
} from "./tenant-kv";
import { buildTrustedCallerTransferHeaders, normalizeTrustedCallerNumber } from "./trusted-caller-propagation";
import { CallerSecurityService } from "./caller-security";
import { decodeHumanHandoffClientState } from "./human-handoff";
import { selectRealtimeProvider, type RealtimeProviderSelection } from "./realtime-provider-selector.js";
import { requireInboundRealtimeRouteReady, type InboundRealtimeRoute } from "./inbound-realtime-route.js";
import {
  authorizeRealtimeProviderTraffic,
  type RealtimeProviderTrafficAdmission,
} from "./realtime-provider-traffic-admission.js";
import { admitGeminiMediaEdgeInboundCall } from "./gemini-media-edge-inbound-admission.js";
import { createGeminiMediaEdgeHmacCredentialIssuer } from "./gemini-media-edge-hmac-credential-issuer.js";
import { registerGeminiMediaEdgeBootstrapForAdmittedSession } from "./gemini-media-edge-bootstrap-registration.js";
import { geminiMediaEdgeAuditView } from "./gemini-media-edge-session-contract.js";
import { TelnyxGeminiStreamingRuntime } from "./telnyx-gemini-streaming-port.js";
import { requireTelnyxWebhookAdmissionIdentity } from "./telnyx-webhook-admission-identity.js";
export { CallSession } from "./call-session-v13";

type WorkerEnv = {
  ENVIRONMENT: string;
  TENANT_CONFIG: TenantKvNamespace;
  OPENAI_PROJECT_ID: string;
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  GEMINI_REALTIME_ENABLED?: string;
  GEMINI_CANARY_TENANT_ID?: string;
  GEMINI_MEDIA_EDGE_URL?: string;
  MEDIA_EDGE_CONTROL_PLANE_TOKEN?: string;
  MEDIA_EDGE_CREDENTIAL_HMAC_SECRET?: string;
  CALL_SESSIONS: DurableObjectNamespace;
};

type TelnyxVoiceEvent = {
  data?: {
    id?: string;
    occurred_at?: string;
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
function decodeBase64(value: string): Uint8Array<ArrayBuffer> { const binary = atob(value.replace(/\s+/g, "")); const bytes = new Uint8Array(new ArrayBuffer(binary.length)); for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); return bytes; }
function decodeTelnyxPublicKey(value: string): { format: "raw" | "spki"; bytes: Uint8Array<ArrayBuffer> } { const trimmed = requireEnvString(value, "TELNYX_PUBLIC_KEY"); if (trimmed.includes("BEGIN PUBLIC KEY")) { const base64 = trimmed.replace(/-----BEGIN PUBLIC KEY-----/g, "").replace(/-----END PUBLIC KEY-----/g, "").replace(/\s+/g, ""); return { format: "spki", bytes: decodeBase64(base64) }; } const bytes = decodeBase64(trimmed); return bytes.byteLength === 32 ? { format: "raw", bytes } : { format: "spki", bytes }; }
async function verifyTelnyxSignature(rawBody: string, request: Request, publicKeyValue: string): Promise<boolean> { const signature = request.headers.get("telnyx-signature-ed25519"); const timestamp = request.headers.get("telnyx-timestamp"); if (!signature || !timestamp) return false; const timestampSeconds = Number(timestamp); if (!Number.isFinite(timestampSeconds)) return false; if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 300) return false; const decoded = decodeTelnyxPublicKey(publicKeyValue); const key = await crypto.subtle.importKey(decoded.format, decoded.bytes, { name: "Ed25519" }, false, ["verify"]); return crypto.subtle.verify("Ed25519", key, decodeBase64(signature), new TextEncoder().encode(`${timestamp}|${rawBody}`)); }
function buildOpenAISipUri(env: WorkerEnv): string { return `sip:${requireEnvString(env.OPENAI_PROJECT_ID, "OPENAI_PROJECT_ID")}@sip.api.openai.com;transport=tls`; }

async function requireCallSessionRequest(
  stub: DurableObjectStub,
  pathname: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const response = await stub.fetch(`https://call-session.internal${pathname}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`CallSession ${pathname} failed with HTTP ${response.status}`);
  return response;
}

async function startGeminiCallSession(
  env: WorkerEnv,
  input: Parameters<Parameters<typeof admitGeminiMediaEdgeInboundCall>[1]["startCallSession"]>[0],
  callerPhone: string,
): Promise<DurableObjectStub> {
  if (!env.CALL_SESSIONS || typeof env.CALL_SESSIONS.idFromName !== "function") {
    throw new Error("CALL_SESSIONS binding unavailable");
  }
  const callControlId = input.contract.binding.callControlId;
  const stub = env.CALL_SESSIONS.get(env.CALL_SESSIONS.idFromName(callControlId));
  await requireCallSessionRequest(stub, "/caller-context", { caller_phone: callerPhone });
  await requireCallSessionRequest(stub, "/human-handoff/context", {
    telnyx_call_control_id: callControlId,
    called_number: input.tenant.resolution.calledNumber,
    realtime_call_id: callControlId,
  });
  await requireCallSessionRequest(stub, "/start", {
    call_id: callControlId,
    tenant_id: input.selection.tenantId,
    business_name: input.tenant.configuration.business.displayName,
    assistant_name: input.tenant.configuration.assistant.name,
    initial_greeting: input.tenant.configuration.assistant.greeting,
    allowed_tools: input.tenant.configuration.tools.allowed,
    business_facts: input.tenant.configuration.business.facts,
    realtime_provider: input.selection.provider,
    realtime_provider_source: input.selection.source,
  });
  return stub;
}

async function requireGeminiCallSessionSideband(callSession: object): Promise<void> {
  const stub = callSession as DurableObjectStub;
  const response = await requireCallSessionRequest(stub, "/realtime-provider/status");
  const status = await response.json() as { provider?: unknown; sideband_ready?: unknown };
  if (status.provider !== "GEMINI" || status.sideband_ready !== true) {
    throw new Error("Gemini CallSession sideband is not ready");
  }
}

async function transferToOpenAIRealtime(
  callControlId: string,
  eventId: string,
  resolution: TenantResolutionV1,
  callerPhone: string,
  selection: RealtimeProviderSelection,
  route: InboundRealtimeRoute,
  env: WorkerEnv,
): Promise<void> {
  if (selection.provider !== "OPENAI" || route.transport !== "OPENAI_DIRECT_SIP") {
    throw new Error(`OpenAI transfer rejected for immutable provider ${selection.provider} via ${route.transport}`);
  }
  const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnvString(env.TELNYX_API_KEY, "TELNYX_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: buildOpenAISipUri(env),
      from: callerPhone,
      sip_transport_protocol: "TLS",
      timeout_secs: 30,
      command_id: eventId,
      custom_headers: buildTrustedCallerTransferHeaders(
        callerPhone,
        resolution.tenantId,
        resolution.calledNumber,
        resolution.source,
        callControlId,
        { provider: selection.provider, source: selection.source },
      ),
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    console.error(JSON.stringify({ level: "error", event: "telnyx_transfer_with_caller_failed", tenant_id: resolution.tenantId, provider: selection.provider, status: response.status, response: body.slice(0, 1000) }));
    throw new Error(`Telnyx transfer failed with HTTP ${response.status}`);
  }
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

async function resolveInboundRealtime(
  repository: KvTenantRepository,
  calledNumber: string,
  kv: TenantKvNamespace,
  env: Pick<WorkerEnv, "ENVIRONMENT" | "GEMINI_REALTIME_ENABLED" | "GEMINI_CANARY_TENANT_ID">,
): Promise<{
  resolution: TenantResolutionV1;
  config: TenantConfiguration;
  selection: RealtimeProviderSelection;
  admission: RealtimeProviderTrafficAdmission;
  route: InboundRealtimeRoute;
} | null> {
  const resolution = await repository.resolveByCalledNumber(calledNumber);
  if (!resolution) return null;
  const config = await repository.getTenantConfiguration(resolution.tenantId);
  if (!config) return null;
  const selection = await selectRealtimeProvider(config, kv);
  const admission = authorizeRealtimeProviderTraffic(selection, {
    environment: env.ENVIRONMENT,
    geminiEnabled: env.GEMINI_REALTIME_ENABLED,
    geminiCanaryTenantId: env.GEMINI_CANARY_TENANT_ID,
  });
  const route = requireInboundRealtimeRouteReady(selection, admission);
  return { resolution, config, selection, admission, route };
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
  let admissionIdentity: ReturnType<typeof requireTelnyxWebhookAdmissionIdentity>;
  try {
    admissionIdentity = requireTelnyxWebhookAdmissionIdentity(event.data ?? {});
  } catch {
    return json({ ok: false, error: "invalid_webhook_event_identity" }, 400);
  }
  const eventId = admissionIdentity.eventId;

  const repository = new KvTenantRepository(env.TENANT_CONFIG);
  let inbound: Awaited<ReturnType<typeof resolveInboundRealtime>>;
  try {
    inbound = await resolveInboundRealtime(repository, calledNumber, env.TENANT_CONFIG, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: "error", event: "inbound_realtime_route_rejected", called_number: calledNumber, error: message, fallback_provider_used: false }));
    ctx.waitUntil(rejectSecurityBlockedCall(callControlId, eventId, env).catch(() => undefined));
    return json({ ok: false, error: "realtime_provider_unavailable", fallback_provider_used: false }, 503);
  }
  if (!inbound) return json({ ok: false, error: "tenant_not_found" }, 404);

  const { resolution, config, selection, route } = inbound;

  if (route.transport === "GEMINI_MEDIA_BRIDGE") {
    const securityState: {
      value: Awaited<ReturnType<CallerSecurityService["evaluateInbound"]>> | null;
    } = { value: null };
    const answerState: { completed: boolean } = { completed: false };
    try {
      const eventOccurredAt = admissionIdentity.occurredAt;
      const edgeUrl = requireEnvString(env.GEMINI_MEDIA_EDGE_URL, "GEMINI_MEDIA_EDGE_URL");
      const controlPlaneToken = requireEnvString(env.MEDIA_EDGE_CONTROL_PLANE_TOKEN, "MEDIA_EDGE_CONTROL_PLANE_TOKEN");
      const issueCredential = createGeminiMediaEdgeHmacCredentialIssuer(
        requireEnvString(env.MEDIA_EDGE_CREDENTIAL_HMAC_SECRET, "MEDIA_EDGE_CREDENTIAL_HMAC_SECRET"),
        () => `${eventId}-gemini-edge`,
      );
      const streaming = new TelnyxGeminiStreamingRuntime({ env: env as unknown as Record<string, unknown> });
      const result = await admitGeminiMediaEdgeInboundCall({
        calledNumber,
        callerPhone,
        answerCommandId: `${eventId}-gemini-answer`,
        commandId: `${eventId}-gemini-stream`,
        provisioning: {
          callControlId,
          edgeUrl,
          targetLegs: "self",
          notAfterEpochMs: admissionIdentity.credentialNotAfterEpochMs,
        },
        trafficPolicy: {
          environment: env.ENVIRONMENT,
          geminiEnabled: env.GEMINI_REALTIME_ENABLED,
          geminiCanaryTenantId: env.GEMINI_CANARY_TENANT_ID,
        },
        controlPlaneToken,
      }, {
        async resolveTenant(receivedCalledNumber) {
          if (receivedCalledNumber !== resolution.calledNumber) throw new Error("Gemini resolved called number changed");
          return { resolution, configuration: config };
        },
        async selectProvider(receivedConfiguration) {
          if (receivedConfiguration !== config) throw new Error("Gemini tenant configuration ownership changed");
          return selection;
        },
        async evaluateCallerSecurity() {
          const security = new CallerSecurityService({ SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY });
          const securityDecision = await security.evaluateInbound(resolution.tenantId, callerPhone, eventId);
          securityState.value = securityDecision;
          console.log(JSON.stringify({
            level: securityDecision.decision === "BLOCK" ? "warn" : "info",
            event: "caller_security_inbound_evaluated",
            tenant_id: resolution.tenantId,
            provider: "GEMINI",
            decision: securityDecision.decision,
            reason: securityDecision.reason,
            calls_1m: securityDecision.calls_1m,
            calls_5m: securityDecision.calls_5m,
            calls_1h: securityDecision.calls_1h,
            risk_score: securityDecision.risk_score,
            security_strikes: securityDecision.security_strikes,
            rate_limit_blocks: securityDecision.rate_limit_blocks,
            permanent_block: securityDecision.permanent_block,
            blocked_until: securityDecision.blocked_until,
          }));
          return securityDecision;
        },
        issueCredential,
        registerBootstrap(input) {
          return registerGeminiMediaEdgeBootstrapForAdmittedSession(input, fetch, () => eventOccurredAt);
        },
        startCallSession(input) {
          return startGeminiCallSession(env, input, callerPhone);
        },
        requireSidebandReady(input) {
          return requireGeminiCallSessionSideband(input.callSession);
        },
        async answerCall(request) {
          const answer = await streaming.answer(request);
          answerState.completed = answer.ok;
          return answer;
        },
        startStreaming(request) {
          return streaming.start(request);
        },
      });
      const edge = geminiMediaEdgeAuditView(result.contract);
      console.log(JSON.stringify({
        level: "info",
        event: "gemini_inbound_admission_completed",
        tenant_id: result.selection.tenantId,
        call_control_id: callControlId,
        provider: result.selection.provider,
        traffic_admission_scope: result.admission.scope,
        edge_origin: edge.edgeOrigin,
        answer_http_status: result.answering.httpStatus ?? null,
        streaming_http_status: result.streaming.httpStatus ?? null,
        stream_auth: edge.streamAuth,
        inbound_answer_before_streaming: true,
        streaming_start_final_effect: true,
      }));
      return json({
        ok: true,
        accepted: true,
        action: "start_gemini_media_stream",
        tenant_id: resolution.tenantId,
        called_number: resolution.calledNumber,
        business_name: config.business.displayName,
        realtime_provider: "GEMINI",
        realtime_provider_source: selection.source,
        realtime_transport: route.transport,
        immutable_provider_affinity: true,
        fallback_provider_used: false,
        caller_number_propagated: true,
        caller_security_checked: true,
        telnyx_call_control_id_propagated: true,
        sideband_ready_before_streaming: true,
        traffic_admission_scope: result.admission.scope,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        level: "error",
        event: "gemini_inbound_admission_failed_closed",
        tenant_id: resolution.tenantId,
        call_control_id: callControlId,
        provider: "GEMINI",
        error: message.includes("caller security rejected")
          ? "CALLER_SECURITY_REJECTED"
          : message.includes("streaming_start")
            ? "STREAMING_START_FAILED"
            : message.includes("CallSession") || message.includes("sideband")
              ? "CALL_SESSION_OR_SIDEBAND_FAILED"
              : message.includes("bootstrap")
                ? "BOOTSTRAP_FAILED"
                : "GEMINI_ADMISSION_FAILED",
        fallback_provider_used: false,
      }));
      const securityDecision = securityState.value;
      if (securityDecision && securityDecision.decision === "BLOCK") {
        ctx.waitUntil(rejectSecurityBlockedCall(callControlId, eventId, env).catch(() => undefined));
        return json({
          ok: true,
          accepted: false,
          action: "security_reject",
          reason: securityDecision.reason,
          blocked_until: securityDecision.blocked_until,
          permanent_block: securityDecision.permanent_block,
        });
      }
      if (!answerState.completed) {
        ctx.waitUntil(rejectSecurityBlockedCall(callControlId, eventId, env).catch(() => undefined));
      } else {
        console.warn(JSON.stringify({
          level: "warn",
          event: "gemini_answered_call_admission_retry_requested",
          tenant_id: resolution.tenantId,
          call_control_id: callControlId,
          reason: message.includes("streaming_start") ? "STREAMING_START_RETRY" : "POST_ANSWER_ADMISSION_RETRY",
          call_rejected: false,
        }));
      }
      return json({
        ok: false,
        accepted: false,
        error: "gemini_admission_failed",
        provider: "GEMINI",
        fallback_provider_used: false,
        traffic_admission_scope: inbound.admission.scope,
      }, 503);
    }
  }

  try {
    const security = new CallerSecurityService({ SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY });
    const decision = await security.evaluateInbound(resolution.tenantId, callerPhone, eventId);
    console.log(JSON.stringify({
      level: decision.decision === "BLOCK" ? "warn" : "info",
      event: "caller_security_inbound_evaluated",
      tenant_id: resolution.tenantId,
      provider: selection.provider,
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
    console.error(JSON.stringify({ level: "error", event: "caller_security_inbound_check_failed_closed", tenant_id: resolution.tenantId, error: error instanceof Error ? error.message : String(error) }));
    ctx.waitUntil(rejectSecurityBlockedCall(callControlId, eventId, env).catch((rejectError) => {
      console.error(JSON.stringify({ level: "error", event: "caller_security_unavailable_reject_failed", tenant_id: resolution.tenantId, error: rejectError instanceof Error ? rejectError.message : String(rejectError) }));
    }));
    return json({ ok: true, accepted: false, action: "security_unavailable_reject" });
  }

  ctx.waitUntil(transferToOpenAIRealtime(callControlId, eventId, resolution, callerPhone, selection, route, env));
  return json({
    ok: true,
    accepted: true,
    action: "transfer_to_realtime",
    tenant_id: resolution.tenantId,
    called_number: resolution.calledNumber,
    business_name: config.business.displayName,
    realtime_provider: selection.provider,
    realtime_provider_source: selection.source,
    realtime_transport: route.transport,
    immutable_provider_affinity: true,
    fallback_provider_used: false,
    caller_number_propagated: true,
    caller_security_checked: true,
    telnyx_call_control_id_propagated: true,
    traffic_admission_scope: inbound.admission.scope,
  });
}

export default { async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> { const url = new URL(request.url); if (request.method === "POST" && url.pathname === "/webhooks/telnyx") return handleTelnyxWebhook(request, env, ctx); return baseHandler.fetch(request, env as never, ctx); } } satisfies ExportedHandler<WorkerEnv>;
