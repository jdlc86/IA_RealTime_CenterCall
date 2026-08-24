import type { SemanticToolGatePort } from "./semantic-tool-gate-port.js";
import { createRealtimeBackedSemanticToolGatePort } from "./semantic-tool-gate-port.js";
import {
  realtimeCommandPortFor,
  realtimeProviderFor,
  type RealtimeProviderHost,
} from "./realtime-provider-runtime.js";

const FALLBACK_TOOL_GATE_BY_HOST = new WeakMap<object, SemanticToolGatePort>();
const EXTERNAL_TOOL_GATE_BY_HOST = new WeakMap<object, SemanticToolGatePort>();

function requireHost(host: object): object {
  if (!host || typeof host !== "object") throw new Error("Semantic tool gate host is required");
  return host;
}

function requirePort(port: SemanticToolGatePort): SemanticToolGatePort {
  if (!port || typeof port.arm !== "function" || typeof port.release !== "function") {
    throw new Error("Semantic tool gate port is required");
  }
  return port;
}

/**
 * Installs provider-specific semantic gate enforcement for exactly one session.
 * Registry ownership only needs stable host object identity; it does not require
 * provider wire methods. The caller/core still owns when the gate is armed.
 */
export function installSemanticToolGatePort(
  host: object,
  port: SemanticToolGatePort,
): void {
  const key = requireHost(host);
  const capability = requirePort(port);
  const existing = EXTERNAL_TOOL_GATE_BY_HOST.get(key);
  if (existing && existing !== capability) throw new Error("Semantic tool gate port is already installed");
  EXTERNAL_TOOL_GATE_BY_HOST.set(key, capability);
}

export function removeSemanticToolGatePort(
  host: object,
  port?: SemanticToolGatePort,
): void {
  const key = requireHost(host);
  const existing = EXTERNAL_TOOL_GATE_BY_HOST.get(key);
  if (!existing) return;
  if (port && existing !== port) throw new Error("Semantic tool gate port ownership mismatch");
  EXTERNAL_TOOL_GATE_BY_HOST.delete(key);
}

export function semanticToolGatePortFor(host: RealtimeProviderHost): SemanticToolGatePort {
  const key = requireHost(host);
  const external = EXTERNAL_TOOL_GATE_BY_HOST.get(key);
  if (external) return external;

  let port = FALLBACK_TOOL_GATE_BY_HOST.get(key);
  if (!port) {
    port = createRealtimeBackedSemanticToolGatePort(
      realtimeProviderFor(host),
      realtimeCommandPortFor(host),
    );
    FALLBACK_TOOL_GATE_BY_HOST.set(key, port);
  }
  return port;
}
