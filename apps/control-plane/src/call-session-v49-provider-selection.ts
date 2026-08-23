import { CallSession as CallSessionV48 } from "./call-session-v48-authoritative-clock";
import { KvTenantRepository, type TenantKvNamespace } from "./tenant-kv.js";
import {
  DEFAULT_REALTIME_PROVIDER,
  ENABLED_REALTIME_PROVIDERS,
  REGISTERED_REALTIME_PROVIDERS,
  selectRealtimeProvider,
  type RealtimeProviderSelection,
} from "./realtime-provider-selector.js";
import { parseRealtimeProviderAffinity } from "./realtime-provider-affinity.js";
import { bindRealtimeProvider } from "./realtime-provider-runtime.js";

const BaseConstructor = CallSessionV48 as unknown as new (...args: any[]) => any;

type StartProviderAffinity = {
  realtime_provider?: unknown;
  realtime_provider_source?: unknown;
};

/**
 * Provider-selection bootstrap. New production calls carry the provider selected
 * before transport as immutable affinity. Legacy/synthetic starts without affinity
 * retain the old tenant/KV selection path temporarily for compatibility.
 * No path may rebind a call to another provider after binding.
 */
export class CallSession extends BaseConstructor {
  private realtimeProviderSelectionV49: RealtimeProviderSelection | null = null;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";

    if (isStart) {
      let tenantId = "";
      let suppliedAffinity: StartProviderAffinity = {};
      try {
        const body = await request.clone().json() as { tenant_id?: unknown } & StartProviderAffinity;
        tenantId = typeof body.tenant_id === "string" ? body.tenant_id.trim() : "";
        suppliedAffinity = body;
      } catch {
        tenantId = "";
      }

      const hasAnyAffinity = suppliedAffinity.realtime_provider !== undefined
        || suppliedAffinity.realtime_provider_source !== undefined;

      if (hasAnyAffinity) {
        try {
          const affinity = parseRealtimeProviderAffinity(
            suppliedAffinity.realtime_provider,
            suppliedAffinity.realtime_provider_source,
          );
          this.realtimeProviderSelectionV49 = {
            tenantId,
            provider: affinity.provider,
            source: affinity.source,
            overrideKey: "ingress-affinity",
          };
        } catch (error) {
          (this as any).diagnostics?.fail?.(
            "REALTIME_PROVIDER_AFFINITY_REJECTED_G1",
            "REALTIME_PROVIDER_AFFINITY_INVALID",
            { tenant_id: tenantId || null, error: error instanceof Error ? error.message : String(error) },
          );
          return Response.json(
            { error: "realtime_provider_affinity_invalid", tenant_id: tenantId || null },
            { status: 409, headers: { "Cache-Control": "no-store" } },
          );
        }
      } else {
        const kv = (this as any).env?.TENANT_CONFIG as TenantKvNamespace | undefined;
        if (tenantId && kv && typeof kv.get === "function") {
          let config = null;
          try {
            config = await new KvTenantRepository(kv).getTenantConfiguration(tenantId);
          } catch {
            config = null;
          }

          if (config) {
            try {
              this.realtimeProviderSelectionV49 = await selectRealtimeProvider(config, kv);
            } catch (error) {
              (this as any).diagnostics?.fail?.(
                "REALTIME_PROVIDER_SELECTION_REJECTED_GATE_A",
                "REALTIME_PROVIDER_NOT_REGISTERED",
                { tenant_id: tenantId, error: error instanceof Error ? error.message : String(error) },
              );
              return Response.json(
                { error: "realtime_provider_unavailable", tenant_id: tenantId },
                { status: 503, headers: { "Cache-Control": "no-store" } },
              );
            }
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
          { tenant_id: tenantId || null, provider, error: error instanceof Error ? error.message : String(error) },
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
        ingress_affinity: selected?.overrideKey === "ingress-affinity",
        media_transport_changed: false,
      });
    }

    return response;
  }
}
