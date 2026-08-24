import type { AuthoritativeTemporalContextPort } from "./authoritative-temporal-context-port.js";
import { createRealtimeBackedAuthoritativeTemporalContextPort } from "./authoritative-temporal-context-port.js";
import {
  realtimeCommandPortFor,
  realtimeProviderFor,
  type RealtimeProviderHost,
} from "./realtime-provider-runtime.js";

const FALLBACK_TEMPORAL_CONTEXT_PORT_BY_HOST = new WeakMap<object, AuthoritativeTemporalContextPort>();
const EXTERNAL_TEMPORAL_CONTEXT_PORT_BY_HOST = new WeakMap<object, AuthoritativeTemporalContextPort>();

function requireHost(host: object): object {
  if (!host || typeof host !== "object") throw new Error("Authoritative temporal context host is required");
  return host;
}

function requirePort(port: AuthoritativeTemporalContextPort): AuthoritativeTemporalContextPort {
  if (!port || typeof port.refresh !== "function" || typeof port.decideReservationDate !== "function") {
    throw new Error("Authoritative temporal context port is required");
  }
  return port;
}

/**
 * Installs a provider-specific authoritative time strategy for exactly one call.
 * Ownership of when to refresh remains in V48; this capability owns only how the
 * immutable provider affinity realizes the semantic effect.
 */
export function installAuthoritativeTemporalContextPort(
  host: object,
  port: AuthoritativeTemporalContextPort,
): void {
  const key = requireHost(host);
  const capability = requirePort(port);
  const existing = EXTERNAL_TEMPORAL_CONTEXT_PORT_BY_HOST.get(key);
  if (existing && existing !== capability) throw new Error("Authoritative temporal context port is already installed");
  EXTERNAL_TEMPORAL_CONTEXT_PORT_BY_HOST.set(key, capability);
}

export function removeAuthoritativeTemporalContextPort(
  host: object,
  port?: AuthoritativeTemporalContextPort,
): void {
  const key = requireHost(host);
  const existing = EXTERNAL_TEMPORAL_CONTEXT_PORT_BY_HOST.get(key);
  if (!existing) return;
  if (port && existing !== port) throw new Error("Authoritative temporal context port ownership mismatch");
  EXTERNAL_TEMPORAL_CONTEXT_PORT_BY_HOST.delete(key);
}

/** Session-scoped semantic capability; provider identity is already immutable for the call. */
export function authoritativeTemporalContextPortFor(
  host: RealtimeProviderHost,
): AuthoritativeTemporalContextPort {
  const key = requireHost(host);
  const external = EXTERNAL_TEMPORAL_CONTEXT_PORT_BY_HOST.get(key);
  if (external) return external;

  let port = FALLBACK_TEMPORAL_CONTEXT_PORT_BY_HOST.get(key);
  if (!port) {
    port = createRealtimeBackedAuthoritativeTemporalContextPort(
      realtimeProviderFor(host),
      realtimeCommandPortFor(host),
    );
    FALLBACK_TEMPORAL_CONTEXT_PORT_BY_HOST.set(key, port);
  }
  return port;
}
