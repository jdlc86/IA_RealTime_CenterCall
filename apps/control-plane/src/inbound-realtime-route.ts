import { requireRealtimeProviderTrafficReadiness } from "./realtime-provider-capabilities.js";
import type { RealtimeProviderSelection } from "./realtime-provider-selector.js";
import { requireEnabledRealtimeProvider, type RealtimeProviderName } from "./realtime-provider-types.js";

export type InboundRealtimeTransport = "OPENAI_DIRECT_SIP" | "GEMINI_MEDIA_BRIDGE";

export type InboundRealtimeRoute = Readonly<{
  provider: RealtimeProviderName;
  source: RealtimeProviderSelection["source"];
  transport: InboundRealtimeTransport;
}>;

/**
 * Pure topology mapping. This does not enable a provider for traffic.
 * Activation is a separate fail-closed gate so adding a transport implementation
 * cannot silently make that provider live.
 */
export function planInboundRealtimeRoute(selection: RealtimeProviderSelection): InboundRealtimeRoute {
  const transport: InboundRealtimeTransport = selection.provider === "OPENAI"
    ? "OPENAI_DIRECT_SIP"
    : "GEMINI_MEDIA_BRIDGE";
  return Object.freeze({
    provider: selection.provider,
    source: selection.source,
    transport,
  });
}

/**
 * Admission gate for a new call. A provider must be explicitly enabled and must
 * satisfy every product traffic capability before its transport route can be used.
 * There is intentionally no fallback route to another provider.
 */
export function requireInboundRealtimeRouteReady(
  selection: RealtimeProviderSelection,
): InboundRealtimeRoute {
  requireEnabledRealtimeProvider(selection.provider);
  requireRealtimeProviderTrafficReadiness(selection.provider);
  return planInboundRealtimeRoute(selection);
}
