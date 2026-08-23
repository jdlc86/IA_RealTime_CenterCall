import type { RealtimeProviderCommandPort } from "./realtime-provider-command-port.js";
import {
  GeminiLiveSessionRuntime,
  type GeminiLiveSessionRuntimeObservation,
} from "./gemini-live-session-runtime.js";

export type GeminiMediaEdgeSidebandOutbound = Readonly<{
  type: "TOOL_RESULT";
  callId: string;
  toolName: string;
  output: unknown;
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

/**
 * Provider-specific control-plane composition for an external Gemini media edge.
 *
 * The media edge owns physical Gemini setup/audio I/O. This runtime adopts the
 * already-sent setup and keeps GeminiLiveSessionOwner as the sole semantic owner
 * for response ids, pending tools, interruption and turn completion.
 */
export class GeminiMediaEdgeSidebandRuntime {
  private readonly runtime: GeminiLiveSessionRuntime;
  readonly commandPort: RealtimeProviderCommandPort;

  constructor(send: GeminiMediaEdgeSidebandSend) {
    if (typeof send !== "function") throw new Error("Gemini media edge sideband sender is required");
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
    return this.runtime.observe(JSON.stringify(envelope.message));
  }

  snapshot() { return this.runtime.snapshot(); }
  close() { return this.runtime.close(); }
}
