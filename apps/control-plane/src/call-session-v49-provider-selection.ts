import { CallSession as CallSessionV48 } from "./call-session-v48-authoritative-clock";
import { KvTenantRepository, type TenantKvNamespace } from "./tenant-kv.js";
import {
  DEFAULT_REALTIME_PROVIDER,
  selectRealtimeProvider,
  type RealtimeProviderSelection,
} from "./realtime-provider-selector.js";
import { bindRealtimeProvider } from "./realtime-provider-runtime.js";

const BaseConstructor = CallSessionV48 as unknown as new (...args: any[]) => any;

/**
 * Gate A bootstrap. Provider selection happens before the established CallSession
 * chain handles /start, so lower layers consume one already-bound provider runtime.
 * No provider-specific branch is introduced into conversation/business logic.
 */
export class CallSession extends BaseConstructor {
  private realtimeProviderSelectionV49: RealtimeProviderSelection | null = null;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";

    if (isStart) {
      bindRealtimeProvider(this as any, DEFAULT_REALTIME_PROVIDER);

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
          // Preserve the pre-Gate-A tenant parsing behavior. Existing layers remain
          // responsible for malformed/missing tenant configuration.
          config = null;
        }

        if (config) {
          try {
            this.realtimeProviderSelectionV49 = await selectRealtimeProvider(config, kv);
            bindRealtimeProvider(this as any, this.realtimeProviderSelectionV49.provider);
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
    }

    const response = await super.fetch(request);

    if (isStart && response.ok) {
      const selected = this.realtimeProviderSelectionV49;
      (this as any).diagnostics?.checkpoint?.("REALTIME_PROVIDER_SELECTED_GATE_A", {
        provider: selected?.provider ?? DEFAULT_REALTIME_PROVIDER,
        source: selected?.source ?? "DEFAULT",
        tenant_id: selected?.tenantId ?? null,
        only_openai_registered: true,
        media_transport_changed: false,
      });
    }

    return response;
  }
}
