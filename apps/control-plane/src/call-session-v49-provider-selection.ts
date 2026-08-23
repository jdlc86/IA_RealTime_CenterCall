import { CallSession as CallSessionV48 } from "./call-session-v48-authoritative-clock";
import { KvTenantRepository, type TenantKvNamespace } from "./tenant-kv.js";
import {
  DEFAULT_REALTIME_PROVIDER,
  ENABLED_REALTIME_PROVIDERS,
  REGISTERED_REALTIME_PROVIDERS,
  selectRealtimeProvider,
  type RealtimeProviderSelection,
} from "./realtime-provider-selector.js";
import { bindRealtimeProvider } from "./realtime-provider-runtime.js";

const BaseConstructor = CallSessionV48 as unknown as new (...args: any[]) => any;

/**
 * Provider-selection bootstrap. The resolved tenant chooses one registered realtime
 * provider before the established CallSession chain handles /start. Binding happens
 * exactly once per call host; registered-but-disabled providers fail closed rather
 * than falling back to OpenAI or sharing another provider's runtime.
 */
export class CallSession extends BaseConstructor {
  private realtimeProviderSelectionV49: RealtimeProviderSelection | null = null;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";

    if (isStart) {
      let tenantId = "";
      try {
        const body = await request.clone().json() as { tenant_id?: unknown };
        tenantId = typeof body.tenant_id === "string" ? body.tenant_id.trim() : "";
      } catch {
        tenantId = "";
      }

      const kv = (this as any).env?.TENANT_CONFIG as TenantKvNamespace | undefined;
      if (tenantId && kv && typeof kv.get === "function") {
        let config = null;
        try {
          config = await new KvTenantRepository(kv).getTenantConfiguration(tenantId);
        } catch {
          // Preserve established tenant parsing behavior. Existing lower layers remain
          // authoritative for malformed/missing tenant configuration.
          config = null;
        }

        if (config) {
          try {
            this.realtimeProviderSelectionV49 = await selectRealtimeProvider(config, kv);
          } catch (error) {
            (this as any).diagnostics?.fail?.(
              "REALTIME_PROVIDER_SELECTION_REJECTED_GATE_A",
              "REALTIME_PROVIDER_NOT_REGISTERED",
              {
                tenant_id: tenantId,
                error: error instanceof Error ? error.message : String(error),
              },
            );
            return Response.json(
              { error: "realtime_provider_unavailable", tenant_id: tenantId },
              { status: 503, headers: { "Cache-Control": "no-store" } },
            );
          }
        }
      }

      const provider = this.realtimeProviderSelectionV49?.provider ?? DEFAULT_REALTIME_PROVIDER;
      try {
        bindRealtimeProvider(this as any, provider);
      } catch (error) {
        (this as any).diagnostics?.fail?.(
          "REALTIME_PROVIDER_BINDING_REJECTED_G1",
          "REALTIME_PROVIDER_NOT_ENABLED",
          {
            tenant_id: tenantId || null,
            provider,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return Response.json(
          { error: "realtime_provider_unavailable", tenant_id: tenantId || null, provider },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
    }

    const response = await super.fetch(request);

    if (isStart && response.ok) {
      const selected = this.realtimeProviderSelectionV49;
      (this as any).diagnostics?.checkpoint?.("REALTIME_PROVIDER_SELECTED_G1", {
        provider: selected?.provider ?? DEFAULT_REALTIME_PROVIDER,
        source: selected?.source ?? "DEFAULT",
        tenant_id: selected?.tenantId ?? null,
        registered_providers: REGISTERED_REALTIME_PROVIDERS,
        enabled_providers: ENABLED_REALTIME_PROVIDERS,
        immutable_call_binding: true,
        media_transport_changed: false,
      });
    }

    return response;
  }
}
