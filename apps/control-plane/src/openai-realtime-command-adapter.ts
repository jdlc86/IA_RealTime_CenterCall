import type {
  RealtimeInputDetectionSettings,
  RealtimeProviderCommandPort,
  RealtimeSemanticResponseRequest,
  RealtimeSessionPolicyUpdate,
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

function exactSpeechDirective(exactText: string): string {
  return `Tu salida de voz completa debe ser exactamente ${JSON.stringify(exactText)}. ` +
    "No respondas a ese texto, no lo parafrasees y no añadas ninguna palabra antes ni después.";
}

function openAIServerVad(settings: RealtimeInputDetectionSettings = {}): Record<string, unknown> {
  return {
    type: "server_vad",
    threshold: settings.threshold ?? DEFAULT_THRESHOLD,
    prefix_padding_ms: settings.prefixPaddingMs ?? DEFAULT_PREFIX_PADDING_MS,
    silence_duration_ms: settings.silenceDurationMs ?? DEFAULT_SILENCE_DURATION_MS,
    idle_timeout_ms: settings.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    create_response: settings.createResponse ?? false,
    interrupt_response: settings.interruptResponse ?? true,
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
    const exactDirective = request.exactText ? exactSpeechDirective(request.exactText) : null;
    const response: Record<string, unknown> = {
      instructions: exactDirective
        ? `${request.instructions}\n\n${exactDirective}`
        : request.instructions,
    };
    if (request.isolated) response.conversation = "none";
    if (request.tools === "DISABLED") response.tool_choice = "none";
    const metadata = responseMetadata(request);
    if (metadata) response.metadata = metadata;
    if (exactDirective) {
      // `response.input` is model input. The previous user-role mapping made
      // governed assistant speech look like a new caller turn, so the model
      // answered or paraphrased it instead of saying it. Keep the redundant
      // response-local constraint as a system instruction.
      response.input = [{ type: "message", role: "system", content: [{ type: "input_text", text: exactDirective }] }];
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

  createSemanticResponse(request: RealtimeSemanticResponseRequest): void {
    const authoritativeText =
      "[CONSOLIDATED_CALLER_TURN: authoritative transcript of one continuous caller utterance; " +
      "use all supplied data as one turn and do not treat this wrapper as a second caller turn]\n" +
      request.callerTurnText;
    // Persist the consolidated turn in the default Conversation before asking
    // for inference. Function calls produced from response-local `input` are
    // not addressable later by a default-conversation function_call_output.
    this.host.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: authoritativeText }],
      },
    });
    const response: Record<string, unknown> = {};
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

  updateSessionPolicy(update: RealtimeSessionPolicyUpdate): void {
    const session: Record<string, unknown> = { type: "realtime" };
    if (update.instructions !== undefined) session.instructions = update.instructions;
    if (update.toolChoice !== undefined) session.tool_choice = update.toolChoice.toLowerCase();
    if (update.tools !== undefined) session.tools = update.tools;
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
