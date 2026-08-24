import type { SemanticDecisionPort } from "./semantic-decision-port.js";
import { createRealtimeBackedSemanticDecisionPort } from "./semantic-decision-port.js";
import {
  realtimeCommandPortFor,
  realtimeProviderFor,
  type RealtimeProviderHost,
} from "./realtime-provider-runtime.js";

const FALLBACK_DECISION_PORT_BY_HOST = new WeakMap<object, SemanticDecisionPort>();
const EXTERNAL_DECISION_PORT_BY_HOST = new WeakMap<object, SemanticDecisionPort>();

function requireHost(host: object): object {
  if (!host || typeof host !== "object") throw new Error("Semantic decision host is required");
  return host;
}

function requirePort(port: SemanticDecisionPort): SemanticDecisionPort {
  if (!port || typeof port.request !== "function") throw new Error("Semantic decision port is required");
  return port;
}

/**
 * Installs a session-scoped isolated decision capability owned outside the realtime
 * media provider. Installation/removal need only stable object identity; the
 * realtime-backed fallback still requires a full RealtimeProviderHost.
 */
export function installSemanticDecisionPort(
  host: object,
  port: SemanticDecisionPort,
): void {
  const key = requireHost(host);
  const capability = requirePort(port);
  const existing = EXTERNAL_DECISION_PORT_BY_HOST.get(key);
  if (existing && existing !== capability) throw new Error("Semantic decision port is already installed");
  EXTERNAL_DECISION_PORT_BY_HOST.set(key, capability);
}

export function removeSemanticDecisionPort(
  host: object,
  port?: SemanticDecisionPort,
): void {
  const key = requireHost(host);
  const existing = EXTERNAL_DECISION_PORT_BY_HOST.get(key);
  if (!existing) return;
  if (port && existing !== port) throw new Error("Semantic decision port ownership mismatch");
  EXTERNAL_DECISION_PORT_BY_HOST.delete(key);
}

/**
 * Stable session-scoped decision capability.
 *
 * An explicitly composed isolated port wins without touching the media provider.
 * Otherwise the current OpenAI baseline delegates to the validated isolated
 * realtime decision mechanism. Unsupported providers therefore still fail closed
 * through their realtime-backed fallback until an external strategy is installed.
 */
export function semanticDecisionPortFor(host: RealtimeProviderHost): SemanticDecisionPort {
  const key = requireHost(host);
  const external = EXTERNAL_DECISION_PORT_BY_HOST.get(key);
  if (external) return external;

  let port = FALLBACK_DECISION_PORT_BY_HOST.get(key);
  if (!port) {
    port = createRealtimeBackedSemanticDecisionPort(
      realtimeProviderFor(host),
      realtimeCommandPortFor(host),
    );
    FALLBACK_DECISION_PORT_BY_HOST.set(key, port);
  }
  return port;
}
