import {
  requireInboundRealtimeRouteReady,
  type InboundRealtimeRoute,
} from "./inbound-realtime-route.js";
import type { RealtimeProviderSelection } from "./realtime-provider-selector.js";
import type { RealtimeProviderTrafficAdmission } from "./realtime-provider-traffic-admission.js";

export type OpenAIInboundRealtimeRoute = InboundRealtimeRoute & Readonly<{
  provider: "OPENAI";
  transport: "OPENAI_DIRECT_SIP";
}>;

export type GeminiInboundRealtimeRoute = InboundRealtimeRoute & Readonly<{
  provider: "GEMINI";
  transport: "GEMINI_MEDIA_BRIDGE";
}>;

export type InboundRealtimeTransportFactories<T> = Readonly<{
  OPENAI_DIRECT_SIP: (route: OpenAIInboundRealtimeRoute) => T;
  GEMINI_MEDIA_BRIDGE: (route: GeminiInboundRealtimeRoute) => T;
}>;

/**
 * Compose a transport for an already-planned route.
 *
 * This function intentionally does not perform traffic admission. It exists so a
 * registered-but-disabled topology can be constructed and tested without weakening
 * the production admission gate. Runtime callers that may create provider effects
 * must use requireInboundRealtimeTransportReady instead.
 */
export function composePlannedInboundRealtimeTransport<T>(
  route: InboundRealtimeRoute,
  factories: InboundRealtimeTransportFactories<T>,
): T {
  if (route.transport === "OPENAI_DIRECT_SIP") {
    if (route.provider !== "OPENAI") {
      throw new Error(`Inbound realtime route/provider mismatch: ${route.provider}/${route.transport}`);
    }
    return factories.OPENAI_DIRECT_SIP(route as OpenAIInboundRealtimeRoute);
  }

  if (route.transport === "GEMINI_MEDIA_BRIDGE") {
    if (route.provider !== "GEMINI") {
      throw new Error(`Inbound realtime route/provider mismatch: ${route.provider}/${route.transport}`);
    }
    return factories.GEMINI_MEDIA_BRIDGE(route as GeminiInboundRealtimeRoute);
  }

  const exhaustive: never = route.transport;
  throw new Error(`Unsupported inbound realtime transport: ${String(exhaustive)}`);
}

/**
 * Production-safe composition boundary: admission is resolved before any transport
 * factory is invoked. A disabled/not-ready provider therefore cannot construct a
 * websocket, start Telnyx streaming, send audio, or fall back through a factory.
 */
export function requireInboundRealtimeTransportReady<T>(
  selection: RealtimeProviderSelection,
  factories: InboundRealtimeTransportFactories<T>,
  admission?: RealtimeProviderTrafficAdmission,
): T {
  const route = requireInboundRealtimeRouteReady(selection, admission);
  return composePlannedInboundRealtimeTransport(route, factories);
}
