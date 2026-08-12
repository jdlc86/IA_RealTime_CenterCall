import baseHandler from "./index-v3";
import { KvTenantRepository, type TenantKvNamespace, type TenantResolutionV1 } from "./tenant-kv";
import { buildTrustedCallerTransferHeaders, normalizeTrustedCallerNumber } from "./trusted-caller-propagation";
export { CallSession } from "./call-session-v9";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requireEnvString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing environment variable: ${name}`);
  return value.trim();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importEd25519PublicKey(value: string): Promise<CryptoKey> {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const bytes = new Uint8Array(trimmed.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)));
    return crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]);
  }
  const pem = trimmed.match(/-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/);
  if (pem) {
    const der = decodeBase64(pem[1].replace(/\s+/g, ""));
    return crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
  }
  const bytes = decodeBase64(trimmed);
  if (bytes.length === 32) return crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.importKey("spki", bytes, { name: "Ed25519" }, false, ["verify"]);
}

async function verifyTelnyxSignature(request: Request, rawBody: string, publicKey: string): Promise<boolean> {
  const signature = request.headers.get("telnyx-signature-ed25519");
  const timestamp = request.headers.get("telnyx-timestamp");
  if (!signature || !timestamp) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 300) return false;
  try {
    const key = await importEd25519PublicKey(publicKey);
    const payload = new TextEncoder().encode(`${timestamp}|${rawBody}`);
    return crypto.subtle.verify({ name: "Ed25519" }, key, decodeBase64(signature), payload);
  } catch {
    return false;
  }
}

async function handleTelnyxWebhook(request: Request, env: WorkerEnv): Promise<Response> {
  const rawBody = await request.text();
  if (!await verifyTelnyxSignature(request, rawBody, requireEnvString(env.TELNYX_PUBLIC_KEY, "TELNYX_PUBLIC_KEY"))) {
    return jsonResponse({ ok: false, error: "INVALID_TELNYX_SIGNATURE" }, 401);
  }

  let event: TelnyxVoiceEvent;
  try { event = JSON.parse(rawBody) as TelnyxVoiceEvent; } catch { return jsonResponse({ ok: false, error: "INVALID_JSON" }, 400); }
  if (event.data?.event_type !== "call.initiated") return jsonResponse({ ok: true, ignored: true });
  const payload = event.data.payload;
  if (!payload?.call_control_id || payload.direction !== "incoming") return jsonResponse({ ok: true, ignored: true });

  const calledNumber = normalizeTrustedCallerNumber(payload.to);
  const callerNumber = normalizeTrustedCallerNumber(payload.from);
  if (!calledNumber) return jsonResponse({ ok: false, error: "CALLED_NUMBER_UNAVAILABLE" }, 400);

  const tenant = await new KvTenantRepository(env.TENANT_CONFIG).resolveByCalledNumber(calledNumber) as TenantResolutionV1 | null;
  if (!tenant) return jsonResponse({ ok: false, error: "TENANT_NOT_FOUND" }, 404);

  const headers = buildTrustedCallerTransferHeaders(callerNumber, calledNumber);
  const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(payload.call_control_id)}/actions/transfer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnvString(env.TELNYX_API_KEY, "TELNYX_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: `sip:${tenant.openaiProjectId ?? requireEnvString(env.OPENAI_PROJECT_ID, "OPENAI_PROJECT_ID")}@sip.api.openai.com;transport=tls`,
      sip_headers: headers,
    }),
  });
  const responseBody = await response.text();
  return new Response(responseBody, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks/telnyx") return handleTelnyxWebhook(request, env);
    return baseHandler.fetch(request, env as any, ctx);
  },
};
