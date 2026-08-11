import baseHandler from "./index-v2";
import { isDebugEnabled } from "./call-diagnostics";
import { KvTenantRepository, type TenantKvNamespace } from "./tenant-kv";
export { CallSession } from "./call-session";

type DebugWorkerEnv = {
  DEBUG_KEY?: string;
  TENANT_CONFIG: TenantKvNamespace;
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

    return baseHandler.fetch(request, env as never, ctx);
  },
} satisfies ExportedHandler<DebugWorkerEnv>;
