import type { FastGeminiToolDeclaration } from "../admission/fast-media";
import {
  createFastHumanHandoffAudit,
  type FastHumanHandoffAcceptedAudit,
  type FastHumanHandoffAuditDependencies,
} from "./fast-human-handoff-audit";

type TenantKv = Readonly<{
  get(key: string): Promise<string | null>;
  put?(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}>;

export type FastHandoffEnv = Readonly<{
  TELNYX_API_KEY: string;
  GEMINI_MEDIA_CONTROL_PLANE_TOKEN: string;
  TENANT_ROUTING_KV: TenantKv;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}>;

export type FastHumanHandoffConfig = Readonly<{
  enabled: boolean;
  destination: Readonly<{ type: "PHONE"; phone: string; label: string }>;
  transfer: Readonly<{ mode: "BLIND"; answerTimeoutSeconds: number }>;
  failurePolicy: Readonly<{ action: "TERMINATE_AND_CALLBACK"; message: string }>;
  successMessage: string;
}>;

export const FAST_TRANSFER_TOOL: FastGeminiToolDeclaration = Object.freeze({
  name: "transfer_call",
  capability: "call.transfer",
  description: "Solicita un handoff terminal a una persona. Úsala solo cuando el caller haya pedido explícitamente hablar con una persona o haya aceptado explícitamente una oferta de transferencia. El destino lo decide el kernel; nunca pidas ni inventes un número de teléfono.",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({
      reason: Object.freeze({ type: "string", description: "Motivo breve de la transferencia." }),
      context_summary: Object.freeze({ type: "string", description: "Resumen opcional y breve para trazabilidad." }),
    }),
    required: Object.freeze(["reason"]),
    additionalProperties: false,
  }),
});

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function required(value: unknown, field: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000\r\n]/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function e164(value: unknown, field: string): string {
  const normalized = required(value, field, 32);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error(`${field} must be E.164`);
  return normalized;
}

function json(raw: string | null, field: string): unknown | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; }
  catch { throw new Error(`${field} is invalid JSON`); }
}

function optionalE164(value: unknown): string | null {
  if (value == null) return null;
  try { return e164(value, "callerPhoneE164"); }
  catch { return null; }
}

function auditText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function acceptedAudit(
  body: Record<string, unknown>,
  config: FastHumanHandoffConfig,
  handoffId: string,
  tenantId: string,
  sourceCallControlId: string,
): FastHumanHandoffAcceptedAudit | null {
  const callerPhone = optionalE164(body.callerPhoneE164);
  if (!callerPhone) return null;
  return Object.freeze({
    handoffId,
    tenantId,
    callId: sourceCallControlId,
    callerPhone,
    reasonCode: auditText(body.reason, 160) ?? "HUMAN_ASSISTANCE_REQUIRED",
    reasonSummary: auditText(body.contextSummary, 500),
    destinationLabel: config.destination.label,
    destinationPhone: config.destination.phone,
  });
}

export function parseFastHumanHandoffConfig(tenantConfigValue: unknown): FastHumanHandoffConfig | null {
  const tenant = record(tenantConfigValue);
  const raw = record(tenant?.humanHandoff ?? tenant?.human_handoff);
  if (!raw) return null;
  if (raw.enabled !== true) return null;
  const destination = record(raw.destination);
  const transfer = record(raw.transfer);
  const failure = record(raw.failurePolicy ?? raw.failure_policy);
  if (!destination || destination.type !== "PHONE") throw new Error("humanHandoff.destination is invalid");
  if (!transfer || transfer.mode !== "BLIND") throw new Error("humanHandoff.transfer is invalid");
  if (!failure || failure.action !== "TERMINATE_AND_CALLBACK") throw new Error("humanHandoff.failurePolicy is invalid");
  const timeout = transfer.answerTimeoutSeconds ?? transfer.answer_timeout_seconds;
  if (!Number.isInteger(timeout) || Number(timeout) < 5 || Number(timeout) > 120) throw new Error("humanHandoff.transfer.answerTimeoutSeconds is invalid");
  return Object.freeze({
    enabled: true,
    destination: Object.freeze({
      type: "PHONE" as const,
      phone: e164(destination.phone, "humanHandoff.destination.phone"),
      label: required(destination.label, "humanHandoff.destination.label", 100),
    }),
    transfer: Object.freeze({ mode: "BLIND" as const, answerTimeoutSeconds: Number(timeout) }),
    failurePolicy: Object.freeze({
      action: "TERMINATE_AND_CALLBACK" as const,
      message: required(failure.message, "humanHandoff.failurePolicy.message", 500),
    }),
    successMessage: required(raw.successMessage ?? raw.success_message, "humanHandoff.successMessage", 500),
  });
}

export function fastCallTransferEnabled(capabilityValue: unknown, tenantId: string): boolean {
  const source = record(capabilityValue);
  if (!source) return false;
  const declared = source.tenant_id ?? source.tenantId;
  if (declared != null && required(declared, "Tenant capabilities tenant id", 256) !== tenantId) return false;
  if (source["call.transfer"] === true) return true;
  return record(source.call)?.transfer === true;
}

export function fastHumanHandoffPrompt(config: FastHumanHandoffConfig): string {
  return [
    "Política de transferencia humana:",
    `- El destino configurado es ${config.destination.label}; el número es privado y nunca debe solicitarse, mencionarse ni inventarse.`,
    "- La transferencia es terminal: después de autorizarla no continúes la conversación ni hagas nuevas preguntas.",
    "- Solo usa transfer_call si el caller pide explícitamente una persona o confirma explícitamente una oferta previa de transferencia.",
    "- Si transfer_call devuelve OFFER_REQUIRED, ofrece brevemente pasar con una persona y espera una confirmación explícita.",
    "- Si transfer_call devuelve CALLER_REJECTED, continúa ayudando normalmente y no transfieras.",
    `- Si transfer_call devuelve HUMAN_HANDOFF_ACCEPTED, pronuncia exactamente esta frase y nada más: ${JSON.stringify(config.successMessage)}`,
    "- No afirmes que la persona ya contestó. El kernel inicia la transferencia cuando termina ese anuncio.",
    "- Si el destino no responde, la IA no vuelve: el sistema reproducirá un mensaje terminal fijo y finalizará la llamada.",
  ].join("\n");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

type HandoffState = Readonly<{
  kind: "gemini_handoff_v1";
  handoffId: string;
  tenantId: string;
  sourceCallControlId: string;
}>;

function encodeState(state: HandoffState): string {
  return base64(new TextEncoder().encode(JSON.stringify(state)));
}

function decodeState(value: unknown): HandoffState | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(unbase64(value.trim()))) as Record<string, unknown>;
    if (parsed.kind !== "gemini_handoff_v1") return null;
    return Object.freeze({
      kind: "gemini_handoff_v1" as const,
      handoffId: required(parsed.handoffId, "handoffId", 128),
      tenantId: required(parsed.tenantId, "tenantId", 256),
      sourceCallControlId: required(parsed.sourceCallControlId, "sourceCallControlId", 512),
    });
  } catch { return null; }
}

async function secureEqual(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function controlAuthorized(request: Request, expected: string): Promise<boolean> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")?.trim() ?? "");
  return Boolean(match && await secureEqual(match[1], expected));
}

async function tenantHandoff(kv: TenantKv, tenantId: string): Promise<{ config: FastHumanHandoffConfig; capability: true }> {
  const [configRaw, capabilityRaw] = await Promise.all([
    kv.get(`tenant_config:${tenantId}`),
    kv.get(`tenant_capabilities:${tenantId}`),
  ]);
  const configValue = json(configRaw, "Tenant config");
  const capabilityValue = json(capabilityRaw, "Tenant capabilities");
  const config = parseFastHumanHandoffConfig(configValue);
  if (!config || !fastCallTransferEnabled(capabilityValue, tenantId)) throw new Error("call.transfer is not enabled");
  return { config, capability: true };
}

async function verifyRouting(kv: TenantKv, tenantId: string, calledPhoneE164: string): Promise<void> {
  const route = record(json(await kv.get(`tenant_by_phone:${calledPhoneE164}`), "Tenant route"));
  if (!route || route.enabled !== true || required(route.tenant_id, "Tenant route tenant id", 256) !== tenantId) {
    throw new Error("Tenant route mismatch");
  }
}

async function telnyxAction(apiKey: string, callControlId: string, action: "transfer" | "speak" | "hangup", body: Record<string, unknown>): Promise<Response> {
  return fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${required(apiKey, "TELNYX_API_KEY", 8_192)}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function speakFailure(env: FastHandoffEnv, state: HandoffState, message: string, clientState: string): Promise<void> {
  await telnyxAction(env.TELNYX_API_KEY, state.sourceCallControlId, "speak", {
    payload: message,
    payload_type: "text",
    voice: "Azure.es-ES-ElviraNeural",
    language: "es-ES",
    service_level: "premium",
    target_legs: "self",
    client_state: clientState,
    command_id: `gemini-handoff-failure-${state.handoffId}`.slice(0, 128),
  });
}

async function readRequestJson(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json() as unknown;
  const parsed = record(value);
  if (!parsed) throw new Error("request body is invalid");
  return parsed;
}

export async function routeFastTransferAuthorize(
  request: Request,
  env: FastHandoffEnv,
  auditDependencies: FastHumanHandoffAuditDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!await controlAuthorized(request, env.GEMINI_MEDIA_CONTROL_PLANE_TOKEN)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const body = await readRequestJson(request);
    const tenantId = required(body.tenantId, "tenantId", 256);
    const calledPhoneE164 = e164(body.calledPhoneE164, "calledPhoneE164");
    const sourceCallControlId = required(body.callControlId, "callControlId", 512);
    await verifyRouting(env.TENANT_ROUTING_KV, tenantId, calledPhoneE164);
    const { config } = await tenantHandoff(env.TENANT_ROUTING_KV, tenantId);
    const handoffId = crypto.randomUUID();
    const accepted = acceptedAudit(body, config, handoffId, tenantId, sourceCallControlId);
    if (accepted) createFastHumanHandoffAudit(env, auditDependencies).accepted(accepted);
    return Response.json({
      ok: true,
      status: "HUMAN_HANDOFF_ACCEPTED",
      handoffId,
      successMessage: config.successMessage,
      destinationLabel: config.destination.label,
      terminal: true,
      sourceCallControlIdPresent: Boolean(sourceCallControlId),
    });
  } catch {
    return Response.json({ ok: false, status: "HUMAN_HANDOFF_NOT_AVAILABLE" }, { status: 403 });
  }
}

export async function routeFastTransferStart(
  request: Request,
  env: FastHandoffEnv,
  auditDependencies: FastHumanHandoffAuditDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!await controlAuthorized(request, env.GEMINI_MEDIA_CONTROL_PLANE_TOKEN)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const audit = createFastHumanHandoffAudit(env, auditDependencies);
  let auditIdentity: Readonly<{ handoffId: string; tenantId: string }> | null = null;
  try {
    const body = await readRequestJson(request);
    const tenantId = required(body.tenantId, "tenantId", 256);
    const calledPhoneE164 = e164(body.calledPhoneE164, "calledPhoneE164");
    const sourceCallControlId = required(body.callControlId, "callControlId", 512);
    const handoffId = required(body.handoffId, "handoffId", 128);
    auditIdentity = Object.freeze({ handoffId, tenantId });
    await verifyRouting(env.TENANT_ROUTING_KV, tenantId, calledPhoneE164);
    const { config } = await tenantHandoff(env.TENANT_ROUTING_KV, tenantId);
    const accepted = acceptedAudit(body, config, handoffId, tenantId, sourceCallControlId);
    if (accepted) audit.accepted(accepted);
    audit.patch(handoffId, tenantId, { transfer_started_at: (auditDependencies.now ?? (() => new Date()))().toISOString() });
    const state: HandoffState = Object.freeze({ kind: "gemini_handoff_v1", handoffId, tenantId, sourceCallControlId });
    const correlationState = encodeState(state);
    const response = await telnyxAction(env.TELNYX_API_KEY, sourceCallControlId, "transfer", {
      to: config.destination.phone,
      from: calledPhoneE164,
      timeout_secs: config.transfer.answerTimeoutSeconds,
      command_id: `gemini-handoff-transfer-${handoffId}`.slice(0, 128),
      client_state: correlationState,
      target_leg_client_state: correlationState,
    });
    if (!response.ok) {
      audit.patch(handoffId, tenantId, {
        status: "FAILED",
        transfer_ended_at: (auditDependencies.now ?? (() => new Date()))().toISOString(),
        callback_required: true,
        callback_status: "PENDING",
        failure_reason: `TELNYX_TRANSFER_START_HTTP_${response.status}`,
      });
      await speakFailure(env, state, config.failurePolicy.message, correlationState);
      return Response.json({ ok: false, status: "TRANSFER_FAILED_TERMINAL_MESSAGE_STARTED" }, { status: 502 });
    }
    audit.patch(handoffId, tenantId, { status: "DIALING" });
    return Response.json({ ok: true, status: "DIALING", handoffId, terminal: true }, { status: 202 });
  } catch {
    if (auditIdentity) {
      audit.patch(auditIdentity.handoffId, auditIdentity.tenantId, {
        status: "FAILED",
        transfer_ended_at: (auditDependencies.now ?? (() => new Date()))().toISOString(),
        callback_required: true,
        callback_status: "PENDING",
        failure_reason: "TRANSFER_REJECTED",
      });
    }
    return Response.json({ ok: false, status: "TRANSFER_REJECTED" }, { status: 403 });
  }
}

function payloadFromWebhook(rawBody: string): { eventType: string | null; payload: Record<string, unknown> | null } {
  try {
    const outer = record(JSON.parse(rawBody));
    const data = record(outer?.data);
    return { eventType: typeof data?.event_type === "string" ? data.event_type : null, payload: record(data?.payload) };
  } catch { return { eventType: null, payload: null }; }
}

export function isFastHumanHandoffEventType(eventType: string | null): boolean {
  return eventType === "call.bridged" || eventType === "call.hangup" || eventType === "call.speak.ended";
}

function failureStatus(hangupCause: unknown): "NO_ANSWER" | "BUSY" | "FAILED" | null {
  const cause = typeof hangupCause === "string" ? hangupCause.toLowerCase() : "";
  if (cause.includes("timeout") || cause.includes("no_answer") || cause.includes("no-answer")) return "NO_ANSWER";
  if (cause.includes("busy")) return "BUSY";
  if (cause.includes("rejected") || cause.includes("failed")) return "FAILED";
  return null;
}

export async function handleVerifiedFastHumanHandoffEvent(
  rawBody: string,
  env: FastHandoffEnv,
  auditDependencies: FastHumanHandoffAuditDependencies = {},
): Promise<boolean> {
  const { eventType, payload } = payloadFromWebhook(rawBody);
  if (!isFastHumanHandoffEventType(eventType) || !payload) return false;
  const stateRaw = payload.client_state ?? payload.target_leg_client_state;
  const state = decodeState(stateRaw);
  if (!state) return false;
  const audit = createFastHumanHandoffAudit(env, auditDependencies);
  const now = () => (auditDependencies.now ?? (() => new Date()))().toISOString();
  const callControlId = typeof payload.call_control_id === "string" ? payload.call_control_id.trim() : "";
  if (eventType === "call.bridged") {
    const completedAt = now();
    audit.patch(state.handoffId, state.tenantId, {
      status: "TRANSFERRED",
      answered_at: completedAt,
      transfer_ended_at: completedAt,
      callback_required: false,
      callback_status: null,
      ...(callControlId && callControlId !== state.sourceCallControlId ? { target_call_control_id: callControlId } : {}),
    });
    if (env.TENANT_ROUTING_KV.put) {
      await env.TENANT_ROUTING_KV.put(`handoff_bridged:${state.handoffId}`, "1", { expirationTtl: 3600 });
    }
    return true;
  }
  if (eventType === "call.speak.ended" && callControlId === state.sourceCallControlId) {
    await telnyxAction(env.TELNYX_API_KEY, state.sourceCallControlId, "hangup", {
      command_id: `gemini-handoff-hangup-${state.handoffId}`.slice(0, 128),
    });
    return true;
  }
  if (eventType === "call.hangup" && callControlId === state.sourceCallControlId) {
    const terminatedAt = now();
    const bridged = await env.TENANT_ROUTING_KV.get(`handoff_bridged:${state.handoffId}`);
    audit.patch(state.handoffId, state.tenantId, bridged
      ? { call_terminated_at: terminatedAt }
      : {
          status: "TERMINATED",
          transfer_ended_at: terminatedAt,
          call_terminated_at: terminatedAt,
          callback_required: true,
          callback_status: "PENDING",
          failure_reason: `SOURCE_CALL_HANGUP:${auditText(payload.hangup_cause, 200) ?? "unknown"}`,
        });
    return true;
  }
  if (eventType === "call.hangup" && callControlId && callControlId !== state.sourceCallControlId) {
    const status = failureStatus(payload.hangup_cause);
    if (!status) return true;
    if (await env.TENANT_ROUTING_KV.get(`handoff_bridged:${state.handoffId}`)) return true;
    const { config } = await tenantHandoff(env.TENANT_ROUTING_KV, state.tenantId);
    audit.patch(state.handoffId, state.tenantId, {
      status,
      transfer_ended_at: now(),
      target_call_control_id: callControlId,
      callback_required: true,
      callback_status: "PENDING",
      failure_reason: `TARGET_CALL_HANGUP:${auditText(payload.hangup_cause, 200) ?? "unknown"}`,
    });
    await speakFailure(env, state, config.failurePolicy.message, stateRaw as string);
    return true;
  }
  return true;
}
