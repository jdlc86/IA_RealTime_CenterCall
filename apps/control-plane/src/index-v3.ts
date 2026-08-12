import baseHandler from "./index-v2";
import { isDebugEnabled } from "./call-diagnostics";
import { extractTrustedCallerPhone, type SipHeader } from "./caller-id";
import { KvTenantRepository, type TenantKvNamespace } from "./tenant-kv";
export { CallSession } from "./call-session-v6";

type DebugWorkerEnv = {
  DEBUG_KEY?: string;
  TENANT_CONFIG: TenantKvNamespace;
  CALL_SESSIONS: DurableObjectNamespace;
};

type IncomingCallerContext = {
  callId: string;
  callerPhone: string;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function parseDebugTenantId(pathname: string): string | null {
  const prefix = "/debug/tenant/";
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  let tenantId: string;
  try {
    tenantId = decodeURIComponent(encoded).trim();
  } catch {
    return null;
  }
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(tenantId) ? tenantId : null;
}

async function inspectIncomingCallerContext(request: Request): Promise<IncomingCallerContext | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.text());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const event = parsed as { type?: unknown; data?: unknown };
  if (event.type !== "realtime.call.incoming" || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) return null;
  const data = event.data as { call_id?: unknown; sip_headers?: unknown };
  if (typeof data.call_id !== "string" || !data.call_id.trim()) return null;
  if (!Array.isArray(data.sip_headers)) return null;

  const headers: SipHeader[] = data.sip_headers.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as { name?: unknown; value?: unknown };
    return typeof record.name === "string" && typeof record.value === "string"
      ? [{ name: record.name, value: record.value }]
      : [];
  });
  const callerPhone = extractTrustedCallerPhone(headers);
  return callerPhone ? { callId: data.call_id.trim(), callerPhone } : null;
}

async function attachCallerContext(env: DebugWorkerEnv, context: IncomingCallerContext): Promise<void> {
  if (!env.CALL_SESSIONS || typeof env.CALL_SESSIONS.idFromName !== "function") return;
  const id = env.CALL_SESSIONS.idFromName(context.callId);
  const stub = env.CALL_SESSIONS.get(id);
  const response = await stub.fetch("https://call-session.internal/caller-context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caller_phone: context.callerPhone }),
  });
  if (!response.ok) throw new Error(`CallSession caller context failed with HTTP ${response.status}`);
}

export default {
  async fetch(request: Request, env: DebugWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const tenantId = request.method === "GET" ? parseDebugTenantId(url.pathname) : null;

    if (tenantId) {
      if (!isDebugEnabled(env.DEBUG_KEY)) {
        return json({ ok: false, error: "not_found" }, 404);
      }
      if (!env.TENANT_CONFIG || typeof env.TENANT_CONFIG.get !== "function") {
        return json({ ok: false, error: "tenant_config_unavailable" }, 503);
      }

      try {
        const config = await new KvTenantRepository(env.TENANT_CONFIG).getTenantConfiguration(tenantId);
        if (!config) return json({ ok: false, error: "tenant_not_found" }, 404);

        return json({
          ok: true,
          tenantId: config.tenantId,
          schemaVersion: config.schemaVersion,
          businessType: config.schemaVersion === 2 ? config.businessType : null,
          status: "active",
          allowedToolsCount: config.tools.allowed.length,
          verticalConfigPresent: config.schemaVersion === 2,
        });
      } catch {
        return json({ ok: false, error: "tenant_configuration_invalid" }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/webhooks/openai") {
      const inspected = inspectIncomingCallerContext(request.clone());
      const response = await baseHandler.fetch(request, env as never, ctx);
      const callerContext = await inspected;
      if (response.ok && callerContext) {
        try {
          await attachCallerContext(env, callerContext);
        } catch {
          // Caller context is optional for call continuity. Consent/reservation phone reuse will fail closed if unavailable.
        }
      }
      return response;
    }

    return baseHandler.fetch(request, env as never, ctx);
  },
} satisfies ExportedHandler<DebugWorkerEnv>;
