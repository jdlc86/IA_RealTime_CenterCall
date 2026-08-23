import type { SemanticDecisionPort } from "./semantic-decision-port.js";
import { createRealtimeBackedSemanticDecisionPort } from "./semantic-decision-port.js";
import {
  realtimeCommandPortFor,
  realtimeProviderFor,
  type RealtimeProviderHost,
} from "./realtime-provider-runtime.js";

const DECISION_PORT_BY_HOST = new WeakMap<object, SemanticDecisionPort>();

/**
 * Stable session-scoped decision capability.
 *
 * For the current OpenAI baseline it delegates to the validated isolated
 * realtime decision mechanism. A future Gemini composition may install a
 * different implementation without changing callers or injecting decision text
 * into the Live conversation.
 */
export function semanticDecisionPortFor(host: RealtimeProviderHost): SemanticDecisionPort {
  let port = DECISION_PORT_BY_HOST.get(host);
  if (!port) {
    port = createRealtimeBackedSemanticDecisionPort(
      realtimeProviderFor(host),
      realtimeCommandPortFor(host),
    );
    DECISION_PORT_BY_HOST.set(host, port);
  }
  return port;
}
