import baseHandler from "./index-v3";
import { KvTenantRepository, type TenantKvNamespace, type TenantResolutionV1 } from "./tenant-kv";
import { buildTrustedCallerTransferHeaders, normalizeTrustedCallerNumber } from "./trusted-caller-propagation";
export { CallSession } from "./call-session-v11";

type WorkerEnv = {
  ENVIRONMENT: string;
  TENANT_CONFIG: TenantKvNamespace;
  OPENAI_PROJECT_ID: string;
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
};

type TelnyxVoiceEvent = {
  data?: {
    id?: string;
    event_type?: string;
    payload?: {
      call_control_id?: string;
      direction?: string;
      from?: string;
      to?: string;
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
  const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`, { method: "POST", headers: { Authorization: `Bearer ${requireEnvString(env.TELNYX_API_KEY, "TELNYX_API_KEY")}`, "Content-Type": "application/json" }, body: JSON.stringify({ to: buildOpenAISipUri(env), from: callerPhone, sip_transport_protocol: "TLS", timeout_secs: 30, command_id: eventId, custom_headers: buildTrustedCallerTransferHeaders(callerPhone, resolution.tenantId, resolution.calledNumber, resolution.source) }) });
  if (!response.ok) { const body = await response.text(); console.error(JSON.stringify({ level: "error", event: "telnyx_transfer_with_caller_failed", tenant_id: resolution.tenantId, status: response.status, response: body.slice(0, 1000) })); throw new Error(`Telnyx transfer failed with HTTP ${response.status}`); }
}

async function handleTelnyxWebhook(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const rawBody = await request.text();
  const valid = await verifyTelnyxSignature(rawBody, request, requireEnvString(env.TELNYX_PUBLIC_KEY, "TELNYX_PUBLIC_KEY"));
  if (!valid) return json({ ok: false, error: "invalid_webhook_signature" }, 403);
  let event: TelnyxVoiceEvent; try { event = JSON.parse(rawBody) as TelnyxVoiceEvent; } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const eventType = event.data?.event_type ?? "unknown"; const payload = event.data?.payload;
  if (eventType !== "call.initiated" || payload?.direction !== "incoming") return json({ ok: true, ignored: true, event_type: eventType });
  const callControlId = payload.call_control_id?.trim(); const calledNumber = payload.to?.trim();
  if (!callControlId) return json({ ok: false, error: "missing_call_control_id" }, 400);
  if (!calledNumber) return json({ ok: false, error: "missing_called_number" }, 400);
  const callerPhone = normalizeTrustedCallerNumber(payload.from, calledNumber);
  if (!callerPhone) { console.error(JSON.stringify({ level: "error", event: "trusted_caller_number_missing", called_number: calledNumber })); return json({ ok: false, error: "missing_trusted_caller_number" }, 409); }
  const repository = new KvTenantRepository(env.TENANT_CONFIG); let resolution: TenantResolutionV1 | null;
  try { resolution = await repository.resolveByCalledNumber(calledNumber); } catch { return json({ ok: false, error: "tenant_kv_configuration_invalid" }, 500); }
  if (!resolution) return json({ ok: false, error: "tenant_not_found" }, 404);
  const eventId = event.data?.id ?? crypto.randomUUID(); ctx.waitUntil(transferToRealtime(callControlId, eventId, resolution, callerPhone, env));
  return json({ ok: true, accepted: true, action: "transfer_to_realtime", tenant_id: resolution.tenantId, called_number: resolution.calledNumber, caller_number_propagated: true });
}

export default { async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> { const url = new URL(request.url); if (request.method === "POST" && url.pathname === "/webhooks/telnyx") return handleTelnyxWebhook(request, env, ctx); return baseHandler.fetch(request, env as never, ctx); } } satisfies ExportedHandler<WorkerEnv>;
