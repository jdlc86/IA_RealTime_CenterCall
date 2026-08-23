import type { RealtimeProviderEvent } from "./realtime-provider-event";

type GeminiFunctionCall = {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
};

type GeminiLiveMessage = {
  setupComplete?: Record<string, unknown>;
  toolCall?: { functionCalls?: GeminiFunctionCall[] };
  serverContent?: {
    inputTranscription?: { text?: string; finished?: boolean };
    outputTranscription?: { text?: string; finished?: boolean };
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
 * Translate Gemini Live wire messages into the same provider-neutral event
 * vocabulary consumed by CallSession. G2 deliberately covers text/session/tool
 * conformance only; audio activity/playback evidence belongs to G3/G4.
 */
export function adaptGeminiLiveEvent(data: unknown): RealtimeProviderEvent[] {
  const message = parseGeminiLiveMessage(data);
  if (!message) return [];

  const events: RealtimeProviderEvent[] = [];

  const inputTranscript = message.serverContent?.inputTranscription;
  if (inputTranscript?.finished === true) {
    events.push({
      type: "CALLER_TRANSCRIPT_COMPLETED",
      transcript: typeof inputTranscript.text === "string" ? inputTranscript.text : "",
    });
  }

  const outputTranscript = message.serverContent?.outputTranscription;
  if (outputTranscript?.finished === true) {
    events.push({
      type: "ASSISTANT_TRANSCRIPT_COMPLETED",
      transcript: typeof outputTranscript.text === "string" ? outputTranscript.text : "",
    });
  }

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
