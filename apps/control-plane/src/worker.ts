import baseHandler, { CallSession } from "./index";
import { KvTenantRepository, type TenantKvNamespace } from "./tenant-kv";

export { CallSession };

type ProbeEnv = {
  TENANT_CONFIG?: TenantKvNamespace;
  TENANT_CONFIG_SOURCE?: string;
  TENANT_ROUTES_JSON?: string;
  [key: string]: unknown;
};

function firstConfiguredCalledNumber(env: ProbeEnv): string | null {
  if (typeof env.TENANT_ROUTES_JSON !== "string" || !env.TENANT_ROUTES_JSON.trim()) return null;
  try {
    const parsed = JSON.parse(env.TENANT_ROUTES_JSON) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first = parsed[0] as Record<string, unknown>;
    return typeof first.called_number === "string" && first.called_number.trim()
      ? first.called_number.trim()
      : null;
  } catch {
    return null;
  }
}

async function kvDiagnostic(env: ProbeEnv): Promise<Record<string, unknown>> {
  const bindingPresent = Boolean(env.TENANT_CONFIG && typeof env.TENANT_CONFIG.get === "function");
  const source = typeof env.TENANT_CONFIG_SOURCE === "string" ? env.TENANT_CONFIG_SOURCE : "static";
  const calledNumber = firstConfiguredCalledNumber(env);

  if (!bindingPresent) {
    return {
      tenant_config_source: source,
      kv_binding: false,
      kv_probe_called_number: calledNumber,
      kv_route_found: false,
      kv_tenant_found: false,
      kv_error: "TENANT_CONFIG binding unavailable",
    };
  }

  if (!calledNumber) {
    return {
      tenant_config_source: source,
      kv_binding: true,
      kv_probe_called_number: null,
      kv_route_found: false,
      kv_tenant_found: false,
      kv_error: "No configured called number available for probe",
    };
  }

  try {
    const repository = new KvTenantRepository(env.TENANT_CONFIG!);
    const resolution = await repository.resolveByCalledNumber(calledNumber);
    if (!resolution) {
      return {
        tenant_config_source: source,
        kv_binding: true,
        kv_probe_called_number: calledNumber,
        kv_route_found: false,
        kv_tenant_found: false,
        kv_error: null,
      };
    }

    const tenant = await repository.getTenantConfiguration(resolution.tenantId);
    return {
      tenant_config_source: source,
      kv_binding: true,
      kv_probe_called_number: resolution.calledNumber,
      kv_route_found: true,
      kv_tenant_found: Boolean(tenant),
      kv_tenant_id: resolution.tenantId,
      kv_business_name: tenant?.business.displayName ?? null,
      kv_assistant_name: tenant?.assistant.name ?? null,
      kv_allowed_tools: tenant?.tools.allowed ?? [],
      kv_schema_version: tenant?.schemaVersion ?? null,
      kv_error: null,
    };
  } catch (error) {
    return {
      tenant_config_source: source,
      kv_binding: true,
      kv_probe_called_number: calledNumber,
      kv_route_found: false,
      kv_tenant_found: false,
      kv_error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default {
  async fetch(request: Request, env: ProbeEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const baseResponse = await baseHandler.fetch(request, env as never, ctx);
      let basePayload: Record<string, unknown> = {};
      try {
        basePayload = (await baseResponse.clone().json()) as Record<string, unknown>;
      } catch {
        basePayload = { ok: baseResponse.ok };
      }

      return Response.json(
        {
          ...basePayload,
          ...(await kvDiagnostic(env)),
          kv_probe_mode: "read_only",
        },
        { status: baseResponse.status },
      );
    }

    return baseHandler.fetch(request, env as never, ctx);
  },
};
