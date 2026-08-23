import type { SemanticToolGatePort } from "./semantic-tool-gate-port.js";
import { createRealtimeBackedSemanticToolGatePort } from "./semantic-tool-gate-port.js";
import {
  realtimeCommandPortFor,
  realtimeProviderFor,
  type RealtimeProviderHost,
} from "./realtime-provider-runtime.js";

const TOOL_GATE_BY_HOST = new WeakMap<object, SemanticToolGatePort>();

export function semanticToolGatePortFor(host: RealtimeProviderHost): SemanticToolGatePort {
  let port = TOOL_GATE_BY_HOST.get(host);
  if (!port) {
    port = createRealtimeBackedSemanticToolGatePort(
      realtimeProviderFor(host),
      realtimeCommandPortFor(host),
    );
    TOOL_GATE_BY_HOST.set(host, port);
  }
  return port;
}
