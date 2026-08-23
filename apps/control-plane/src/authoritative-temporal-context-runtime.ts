import type { AuthoritativeTemporalContextPort } from "./authoritative-temporal-context-port.js";
import { createRealtimeBackedAuthoritativeTemporalContextPort } from "./authoritative-temporal-context-port.js";
import {
  realtimeCommandPortFor,
  realtimeProviderFor,
  type RealtimeProviderHost,
} from "./realtime-provider-runtime.js";

const TEMPORAL_CONTEXT_PORT_BY_HOST = new WeakMap<object, AuthoritativeTemporalContextPort>();

/** Session-scoped semantic capability; provider identity is already immutable for the call. */
export function authoritativeTemporalContextPortFor(
  host: RealtimeProviderHost,
): AuthoritativeTemporalContextPort {
  let port = TEMPORAL_CONTEXT_PORT_BY_HOST.get(host);
  if (!port) {
    port = createRealtimeBackedAuthoritativeTemporalContextPort(
      realtimeProviderFor(host),
      realtimeCommandPortFor(host),
    );
    TEMPORAL_CONTEXT_PORT_BY_HOST.set(host, port);
  }
  return port;
}
