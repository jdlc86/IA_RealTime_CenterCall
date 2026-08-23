import type { RealtimeProviderCommandPort } from "./realtime-provider-command-port.js";
import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import {
  GeminiLiveSessionRuntime,
  type GeminiLiveSessionRuntimeObservation,
} from "./gemini-live-session-runtime.js";

export type GeminiMediaEdgeSidebandOutbound =
  | Readonly<{
      type: "TOOL_RESULT";
      callId: string;
      toolName: string;
      output: unknown;
    }>
  | Readonly<{
      type: "PLAYBACK_BINDING";
      responseId: string;
      kind: "NORMAL";
    }>;

export type GeminiMediaEdgeSidebandInbound = Readonly<{
  type: "GEMINI_EVENT";
  message: unknown;
}>;

export type GeminiMediaEdgeSidebandSend = (message: GeminiMediaEdgeSidebandOutbound) => void;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is invalid`);
  return value as Record<string, unknown>;
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function outboundToolResult(message: Record<string, unknown>): GeminiMediaEdgeSidebandOutbound {
  const toolResponse = object(message.toolResponse, "Gemini sideband toolResponse");
  const responses = toolResponse.functionResponses;
  if (!Array.isArray(responses) || responses.length !== 1) {
    throw new Error("Gemini sideband requires exactly one FunctionResponse");
  }
  const response = object(responses[0], "Gemini sideband FunctionResponse");
  const body = object(response.response, "Gemini sideband FunctionResponse response");
  if (!("result" in body)) throw new Error("Gemini sideband FunctionResponse result is required");
  return Object.freeze({
    type: "TOOL_RESULT",
    callId: required(response.id, "Gemini sideband FunctionResponse id"),
    toolName: required(response.name, "Gemini sideband FunctionResponse name"),
    output: structuredClone(body.result),
  });
}

function inboundEnvelope(value: unknown): GeminiMediaEdgeSidebandInbound {
  const frame = object(value, "Gemini media edge sideband frame");
  if (frame.type !== "GEMINI_EVENT") throw new Error("Gemini media edge sideband frame type is unsupported");
  return Object.freeze({ type: "GEMINI_EVENT", message: structuredClone(frame.message) });
}

function playbackBinding(events: readonly RealtimeProviderEvent[]): GeminiMediaEdgeSidebandOutbound | null {
  const started = events.filter(
    (event): event is Extract<RealtimeProviderEvent, { type: "ASSISTANT_RESPONSE_STARTED" }> =>
      event.type === "ASSISTANT_RESPONSE_STARTED",
  );
  if (started.length === 0) return null;
  if (started.length !== 1) throw new Error("Gemini sideband observation produced multiple response starts");
  const responseId = required(started[0].responseId, "Gemini sideband playback response id");
  return Object.freeze({ type: "PLAYBACK_BINDING", responseId, kind: "NORMAL" });
}

/**
 * Provider-specific control-plane composition for an external Gemini media edge.
 *
 * The media edge owns physical Gemini setup/audio I/O. This runtime adopts the
 * already-sent setup and keeps GeminiLiveSessionOwner as the sole semantic owner
 * for response ids, pending tools, interruption and turn completion. Whenever the
 * owner mints a response id, that identity is returned to the edge before the edge
 * is allowed to release correlated PCM to Telnyx.
 */
export class GeminiMediaEdgeSidebandRuntime {
  private readonly runtime: GeminiLiveSessionRuntime;
  private readonly send: GeminiMediaEdgeSidebandSend;
  readonly commandPort: RealtimeProviderCommandPort;

  constructor(send: GeminiMediaEdgeSidebandSend) {
    if (typeof send !== "function") throw new Error("Gemini media edge sideband sender is required");
    this.send = send;
    this.runtime = new GeminiLiveSessionRuntime(
      {
        send(message) {
          send(outboundToolResult(message));
        },
      },
      { model: "external-media-edge" },
    );
    this.runtime.adoptExternalSetupSent();
    this.commandPort = this.runtime.commandPort;
  }

  observe(frame: unknown): GeminiLiveSessionRuntimeObservation {
    const envelope = inboundEnvelope(frame);
    const observation = this.runtime.observe(JSON.stringify(envelope.message));
    const binding = playbackBinding(observation.events);
    if (binding) this.send(binding);
    return observation;
  }

  snapshot() { return this.runtime.snapshot(); }
  close() { return this.runtime.close(); }
}
