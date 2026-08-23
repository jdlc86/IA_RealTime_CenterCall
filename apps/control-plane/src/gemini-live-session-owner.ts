import type { RealtimeProviderEvent } from "./realtime-provider-event";

export type GeminiLiveSessionState =
  | "NEW"
  | "SETUP_SENT"
  | "READY"
  | "GENERATING"
  | "TOOL_WAIT"
  | "INTERRUPTED"
  | "CLOSED";

export type GeminiLiveTranscriptionChunk = Readonly<{
  direction: "INPUT" | "OUTPUT";
  text: string;
}>;

export type GeminiLiveSessionSnapshot = Readonly<{
  state: GeminiLiveSessionState;
  activeResponseId: string | null;
  pendingToolCallIds: readonly string[];
  responseSequence: number;
}>;

export type GeminiLiveOwnerObservation = Readonly<{
  events: readonly RealtimeProviderEvent[];
  transcriptionChunks: readonly GeminiLiveTranscriptionChunk[];
  cancelledToolCallIds: readonly string[];
  snapshot: GeminiLiveSessionSnapshot;
}>;

type GeminiFunctionCall = {
  id?: string;
  name?: string;
};

type GeminiLiveMessage = {
  setupComplete?: Record<string, unknown>;
  toolCall?: { functionCalls?: GeminiFunctionCall[] };
  toolCallCancellation?: { ids?: string[] };
  serverContent?: {
    modelTurn?: unknown;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    generationComplete?: boolean;
    turnComplete?: boolean;
    interrupted?: boolean;
  };
};

function readWireText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function parseWireMessage(data: unknown): GeminiLiveMessage | null {
  const text = readWireText(data);
  if (!text) return null;
  try { return JSON.parse(text) as GeminiLiveMessage; } catch { return null; }
}

/** Stateful authority for Gemini Live protocol/session evidence. */
export class GeminiLiveSessionOwner {
  private state: GeminiLiveSessionState = "NEW";
  private activeResponseId: string | null = null;
  private responseSequence = 0;
  private readonly pendingToolCalls = new Set<string>();

  markSetupSent(): GeminiLiveSessionSnapshot {
    if (this.state !== "NEW") {
      throw new Error(`Gemini Live setup can only be sent once from NEW; current state=${this.state}`);
    }
    this.state = "SETUP_SENT";
    return this.snapshot();
  }

  assertPendingToolCall(callId: string): void {
    if (!callId) throw new Error("Gemini Live tool response requires callId");
    if (!this.pendingToolCalls.has(callId)) {
      throw new Error(`Gemini Live tool response does not match a pending call: ${callId}`);
    }
  }

  noteToolResponseSubmitted(callId: string): GeminiLiveSessionSnapshot {
    this.assertPendingToolCall(callId);
    this.pendingToolCalls.delete(callId);
    if (this.state === "TOOL_WAIT" && this.pendingToolCalls.size === 0) {
      this.state = this.activeResponseId ? "GENERATING" : "READY";
    }
    return this.snapshot();
  }

  close(): GeminiLiveSessionSnapshot {
    this.state = "CLOSED";
    this.activeResponseId = null;
    this.pendingToolCalls.clear();
    return this.snapshot();
  }

  observe(data: unknown): GeminiLiveOwnerObservation {
    if (this.state === "CLOSED") throw new Error("Gemini Live session owner is closed");
    const message = parseWireMessage(data);
    if (!message) return this.observation([], [], []);

    const events: RealtimeProviderEvent[] = [];
    const transcriptionChunks: GeminiLiveTranscriptionChunk[] = [];
    const cancelledToolCallIds: string[] = [];

    if (message.setupComplete) {
      if (this.state !== "SETUP_SENT") {
        throw new Error(`Gemini Live setupComplete requires SETUP_SENT; current state=${this.state}`);
      }
      this.state = "READY";
    }

    const serverContent = message.serverContent;
    if (serverContent?.inputTranscription && typeof serverContent.inputTranscription.text === "string") {
      transcriptionChunks.push({ direction: "INPUT", text: serverContent.inputTranscription.text });
    }
    if (serverContent?.outputTranscription && typeof serverContent.outputTranscription.text === "string") {
      transcriptionChunks.push({ direction: "OUTPUT", text: serverContent.outputTranscription.text });
    }

    const calls = message.toolCall?.functionCalls ?? [];
    if (calls.length > 0) {
      this.requireReadyForServerTurn("toolCall");
      this.ensureResponseStarted(events, "tool_call");
      for (const call of calls) {
        if (!call.id) throw new Error("Gemini Live function call is missing required correlation id");
        this.pendingToolCalls.add(call.id);
      }
      this.state = "TOOL_WAIT";
    }

    if (serverContent?.modelTurn !== undefined || serverContent?.generationComplete === true) {
      this.requireReadyForServerTurn("serverContent");
      this.ensureResponseStarted(events, "model_turn");
      if (this.pendingToolCalls.size === 0) this.state = "GENERATING";
    }

    if (serverContent?.interrupted === true) {
      this.requireReadyForServerTurn("interrupted");
      if (this.activeResponseId) {
        events.push({
          type: "ASSISTANT_RESPONSE_COMPLETED",
          kind: "NORMAL",
          responseId: this.activeResponseId,
          status: "interrupted",
        });
        this.activeResponseId = null;
      }
      this.state = "INTERRUPTED";
    }

    for (const id of message.toolCallCancellation?.ids ?? []) {
      if (!id) continue;
      cancelledToolCallIds.push(id);
      this.pendingToolCalls.delete(id);
    }

    if (serverContent?.turnComplete === true) {
      this.requireReadyForServerTurn("turnComplete");
      if (this.pendingToolCalls.size > 0) {
        this.state = "TOOL_WAIT";
      } else {
        if (this.activeResponseId) {
          events.push({
            type: "ASSISTANT_RESPONSE_COMPLETED",
            kind: "NORMAL",
            responseId: this.activeResponseId,
            status: "completed",
          });
          this.activeResponseId = null;
        }
        this.state = "READY";
      }
    } else if (this.state === "INTERRUPTED" && this.pendingToolCalls.size === 0 && cancelledToolCallIds.length > 0) {
      this.state = "READY";
    }

    return this.observation(events, transcriptionChunks, cancelledToolCallIds);
  }

  snapshot(): GeminiLiveSessionSnapshot {
    return Object.freeze({
      state: this.state,
      activeResponseId: this.activeResponseId,
      pendingToolCallIds: Object.freeze([...this.pendingToolCalls]),
      responseSequence: this.responseSequence,
    });
  }

  private requireReadyForServerTurn(signal: string): void {
    if (this.state === "NEW" || this.state === "SETUP_SENT") {
      throw new Error(`Gemini Live ${signal} arrived before setupComplete; current state=${this.state}`);
    }
  }

  private ensureResponseStarted(events: RealtimeProviderEvent[], purpose: string): void {
    if (this.activeResponseId) return;
    this.responseSequence += 1;
    this.activeResponseId = `gemini-response-${this.responseSequence}`;
    events.push({
      type: "ASSISTANT_RESPONSE_STARTED",
      kind: "NORMAL",
      responseId: this.activeResponseId,
      purpose,
    });
  }

  private observation(
    events: readonly RealtimeProviderEvent[],
    transcriptionChunks: readonly GeminiLiveTranscriptionChunk[],
    cancelledToolCallIds: readonly string[],
  ): GeminiLiveOwnerObservation {
    return Object.freeze({
      events: Object.freeze([...events]),
      transcriptionChunks: Object.freeze([...transcriptionChunks]),
      cancelledToolCallIds: Object.freeze([...cancelledToolCallIds]),
      snapshot: this.snapshot(),
    });
  }
}
