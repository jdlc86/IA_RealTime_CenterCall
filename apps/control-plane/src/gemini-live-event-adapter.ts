import type { RealtimeProviderEvent } from "./realtime-provider-event";

type GeminiFunctionCall = {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
};

type GeminiLiveMessage = {
  setupComplete?: Record<string, unknown>;
  toolCall?: { functionCalls?: GeminiFunctionCall[] };
  toolCallCancellation?: { ids?: string[] };
  serverContent?: {
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    generationComplete?: boolean;
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  error?: { code?: string | number; message?: string };
};

function readGeminiLiveText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function parseGeminiLiveMessage(data: unknown): GeminiLiveMessage | null {
  const text = readGeminiLiveText(data);
  if (!text) return null;
  try { return JSON.parse(text) as GeminiLiveMessage; } catch { return null; }
}

function stringifyArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined;
  try { return JSON.stringify(args); } catch { return undefined; }
}

/**
 * Stateless G2 translation for Gemini Live facts that already have a safe neutral
 * meaning. Transcript chunks, generation lifecycle, interruptions and tool-call
 * cancellations deliberately remain provider-edge evidence until a stateful
 * Gemini session owner can correlate them without timers or invented completion
 * flags. They must not be promoted to completed core events prematurely.
 */
export function adaptGeminiLiveEvent(data: unknown): RealtimeProviderEvent[] {
  const message = parseGeminiLiveMessage(data);
  if (!message) return [];

  const events: RealtimeProviderEvent[] = [];

  for (const call of message.toolCall?.functionCalls ?? []) {
    if (!call.name) continue;
    const event: Extract<RealtimeProviderEvent, { type: "SEMANTIC_TOOL_SELECTED" }> = {
      type: "SEMANTIC_TOOL_SELECTED",
      name: call.name,
    };
    const args = stringifyArgs(call.args);
    if (args !== undefined) event.arguments = args;
    if (call.id) event.callId = call.id;
    events.push(event);
  }

  if (message.error) {
    const event: Extract<RealtimeProviderEvent, { type: "PROVIDER_COMMAND_FAILED" }> = {
      type: "PROVIDER_COMMAND_FAILED",
    };
    if (message.error.code !== undefined) event.code = String(message.error.code);
    if (message.error.message) event.message = message.error.message;
    events.push(event);
  }

  return events;
}
