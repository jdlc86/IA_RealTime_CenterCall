import type {
  RealtimeInputDetectionSettings,
  RealtimeProviderCommandPort,
  RealtimeSpeechRequest,
  RealtimeTextDecisionRequest,
  RealtimeToolResultRequest,
} from "./realtime-provider-command-port";

export type OpenAIRealtimeCommandHost = {
  send(event: Record<string, unknown>): void;
};

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_PREFIX_PADDING_MS = 300;
const DEFAULT_SILENCE_DURATION_MS = 500;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;

function normalizeMetadataValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeOpenAIResponseMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, normalizeMetadataValue(value)]),
  );
  return Object.keys(normalized).length ? normalized : undefined;
}

function responseMetadata(request: { purpose?: string; metadata?: Record<string, unknown> }): Record<string, string> | undefined {
  const metadata: Record<string, unknown> = { ...(request.metadata ?? {}) };
  if (request.purpose && metadata.purpose === undefined) metadata.purpose = request.purpose;
  return normalizeOpenAIResponseMetadata(metadata);
}

function openAIServerVad(settings: RealtimeInputDetectionSettings = {}): Record<string, unknown> {
  return {
    type: "server_vad",
    threshold: settings.threshold ?? DEFAULT_THRESHOLD,
    prefix_padding_ms: settings.prefixPaddingMs ?? DEFAULT_PREFIX_PADDING_MS,
    silence_duration_ms: settings.silenceDurationMs ?? DEFAULT_SILENCE_DURATION_MS,
    idle_timeout_ms: settings.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    create_response: true,
    interrupt_response: true,
  };
}

function openAITurnDetectionUpdate(turnDetection: Record<string, unknown> | null): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      audio: { input: { turn_detection: turnDetection } },
    },
  };
}

/** OpenAI-specific translation of the provider-neutral realtime command port. */
export class OpenAIRealtimeCommandAdapter implements RealtimeProviderCommandPort {
  constructor(private readonly host: OpenAIRealtimeCommandHost) {}

  speak(request: RealtimeSpeechRequest): void {
    const response: Record<string, unknown> = { instructions: request.instructions };
    if (request.isolated) response.conversation = "none";
    if (request.tools === "DISABLED") response.tool_choice = "none";
    const metadata = responseMetadata(request);
    if (metadata) response.metadata = metadata;
    if (request.exactText) {
      response.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: request.exactText }] }];
    }
    const event: Record<string, unknown> = { type: "response.create", response };
    if (request.requestId) event.event_id = request.requestId;
    this.host.send(event);
  }

  requestTextDecision(request: RealtimeTextDecisionRequest): void {
    const response: Record<string, unknown> = {
      conversation: "none",
      output_modalities: ["text"],
      tool_choice: "none",
      instructions: request.instructions,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: request.inputText }] }],
    };
    if (request.maxOutputTokens !== undefined) response.max_output_tokens = request.maxOutputTokens;
    const metadata = responseMetadata(request);
    if (metadata) response.metadata = metadata;
    const event: Record<string, unknown> = { type: "response.create", response };
    if (request.requestId) event.event_id = request.requestId;
    this.host.send(event);
  }

  submitToolResult(request: RealtimeToolResultRequest): void {
    this.host.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: request.callId,
        output: typeof request.output === "string" ? request.output : JSON.stringify(request.output),
      },
    });
  }

  updateSessionPolicy(update: { instructions?: string; toolChoice?: "AUTO" | "NONE" | "REQUIRED" }): void {
    const session: Record<string, unknown> = { type: "realtime" };
    if (update.instructions !== undefined) session.instructions = update.instructions;
    if (update.toolChoice !== undefined) session.tool_choice = update.toolChoice.toLowerCase();
    this.host.send({ type: "session.update", session });
  }

  createDefaultResponse(): void { this.host.send({ type: "response.create" }); }
  cancelResponse(responseId: string): void { this.host.send({ type: "response.cancel", response_id: responseId }); }
  clearPlayback(): void { this.host.send({ type: "output_audio_buffer.clear" }); }
  clearInput(): void { this.host.send({ type: "input_audio_buffer.clear" }); }
  discardInputItem(itemId: string): void { this.host.send({ type: "conversation.item.delete", item_id: itemId }); }
  suspendInputDetection(): void { this.host.send(openAITurnDetectionUpdate(null)); }

  beginNonInterruptingListening(settings: RealtimeInputDetectionSettings = {}): void {
    this.host.send(openAITurnDetectionUpdate({
      ...openAIServerVad(settings),
      create_response: false,
      interrupt_response: false,
    }));
  }

  restoreInputDetection(settings: RealtimeInputDetectionSettings = {}): void {
    this.host.send(openAITurnDetectionUpdate(openAIServerVad(settings)));
  }
}

const BUS_BY_HOST = new WeakMap<object, OpenAIRealtimeCommandAdapter>();

export function realtimeCommandPortFor(host: object & { send(event: Record<string, unknown>): void }): RealtimeProviderCommandPort {
  let port = BUS_BY_HOST.get(host);
  if (!port) {
    port = new OpenAIRealtimeCommandAdapter(host);
    BUS_BY_HOST.set(host, port);
  }
  return port;
}
