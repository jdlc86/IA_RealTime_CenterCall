import type { RealtimeProviderCommandPort, RealtimeSpeechRequest } from "./realtime-provider-command-port";
import { restoreTurnDetectionEvent, suspendTurnDetectionEvent, type TenantVadSettings } from "./protected-turn-detection";

export type OpenAIRealtimeCommandHost = {
  send(event: Record<string, unknown>): void;
};

function responseMetadata(request: RealtimeSpeechRequest): Record<string, unknown> | undefined {
  const metadata = { ...(request.metadata ?? {}) };
  if (request.purpose && metadata.purpose === undefined) metadata.purpose = request.purpose;
  return Object.keys(metadata).length ? metadata : undefined;
}

/** OpenAI-specific translation of the provider-neutral realtime command port. */
export class OpenAIRealtimeCommandAdapter implements RealtimeProviderCommandPort {
  constructor(private readonly host: OpenAIRealtimeCommandHost) {}

  speak(request: RealtimeSpeechRequest): void {
    const response: Record<string, unknown> = {
      instructions: request.instructions,
    };
    if (request.isolated) response.conversation = "none";
    if (request.tools === "DISABLED") response.tool_choice = "none";
    const metadata = responseMetadata(request);
    if (metadata) response.metadata = metadata;
    if (request.exactText) {
      response.input = [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: request.exactText }],
      }];
    }
    const event: Record<string, unknown> = { type: "response.create", response };
    if (request.requestId) event.event_id = request.requestId;
    this.host.send(event);
  }

  createDefaultResponse(): void {
    this.host.send({ type: "response.create" });
  }

  cancelResponse(responseId: string): void {
    this.host.send({ type: "response.cancel", response_id: responseId });
  }

  clearPlayback(): void {
    this.host.send({ type: "output_audio_buffer.clear" });
  }

  clearInput(): void {
    this.host.send({ type: "input_audio_buffer.clear" });
  }

  suspendInputDetection(): void {
    this.host.send(suspendTurnDetectionEvent());
  }

  restoreInputDetection(settings: TenantVadSettings = {}): void {
    this.host.send(restoreTurnDetectionEvent(settings));
  }
}

const BUS_BY_HOST = new WeakMap<object, OpenAIRealtimeCommandAdapter>();

/**
 * Compatibility factory for the current OpenAI runtime. Every CallSession
 * instance gets exactly one adapter even while historical inheritance layers
 * are being retired incrementally.
 */
export function realtimeCommandPortFor(host: object & { send(event: Record<string, unknown>): void }): RealtimeProviderCommandPort {
  let port = BUS_BY_HOST.get(host);
  if (!port) {
    port = new OpenAIRealtimeCommandAdapter(host);
    BUS_BY_HOST.set(host, port);
  }
  return port;
}
