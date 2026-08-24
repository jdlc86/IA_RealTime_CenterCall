import type { RealtimeToolResultRequest } from "./realtime-provider-command-port.js";
import { authoritativeMadridNowContext } from "./temporal-grounding.js";

export const AUTHORITATIVE_TEMPORAL_TOOL_RESULT_INSTRUCTION =
  "Este contexto temporal procede del backend en el instante de este resultado y sustituye cualquier snapshot temporal anterior para responder al turno actual. Usa Europe/Madrid y no derives otra fecha actual por tu cuenta.";

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Adds fresh time evidence to an existing correlated tool result without changing its shape. */
export function withAuthoritativeTemporalToolResult(
  request: RealtimeToolResultRequest,
  now: Date = new Date(),
): RealtimeToolResultRequest {
  const output = object(request.output);
  if (!output) return request;
  return {
    ...request,
    output: {
      ...output,
      authoritative_temporal_context: authoritativeMadridNowContext(now),
      authoritative_temporal_instruction: AUTHORITATIVE_TEMPORAL_TOOL_RESULT_INSTRUCTION,
    },
  };
}
