function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function providerToolCalls(message) {
  const calls = message?.toolCall?.functionCalls ?? message?.tool_call?.function_calls;
  return Array.isArray(calls) ? calls : [];
}

function providerProducedSemanticOutput(message) {
  const server = message?.serverContent ?? message?.server_content;
  if (!server || typeof server !== "object" || Array.isArray(server)) return false;
  const modelTurn = server.modelTurn ?? server.model_turn;
  const output = server.outputTranscription ?? server.output_transcription;
  return modelTurn !== undefined || (typeof output?.text === "string" && output.text.trim().length > 0);
}

/**
 * Product-owned enforcement for Gemini's one-tool semantic decision invariant.
 *
 * Caller audio is committed to Live only after preArm() succeeds. While armed,
 * Gemini may emit transcription/control evidence but it may not produce assistant
 * semantic output before selecting exactly one function. The gate remains closed
 * after that selection until the authenticated control plane explicitly releases
 * it after its own public-tool authorization. Any provider deviation fails closed.
 */
export class GeminiSemanticToolGate {
  constructor() {
    this.activeItemId = null;
    this.confirmed = false;
    this.selectedTool = null;
    this.selectedCallId = null;
  }

  snapshot() {
    return Object.freeze({
      armed: this.activeItemId !== null,
      activeItemId: this.activeItemId,
      confirmed: this.confirmed,
      selectedTool: this.selectedTool,
      selectedCallId: this.selectedCallId,
    });
  }

  preArm(itemId) {
    const id = required(itemId, "Gemini semantic gate caller item id");
    if (this.activeItemId && this.activeItemId !== id) {
      throw new Error(`Gemini semantic gate already owns caller item ${this.activeItemId}`);
    }
    if (!this.activeItemId) {
      this.activeItemId = id;
      this.confirmed = false;
      this.selectedTool = null;
      this.selectedCallId = null;
    }
    return this.snapshot();
  }

  confirmArm() {
    if (!this.activeItemId) throw new Error("Gemini semantic gate cannot arm without a pre-authorized caller turn");
    this.confirmed = true;
    return this.snapshot();
  }

  observeProviderMessage(message) {
    if (!this.activeItemId) return this.snapshot();

    const calls = providerToolCalls(message);
    if (calls.length > 1) throw new Error("Gemini semantic gate received multiple tool decisions for one caller turn");
    if (calls.length === 1) {
      const call = calls[0];
      const callId = required(call?.id, "Gemini semantic gate function call id");
      const toolName = required(call?.name, "Gemini semantic gate function name");
      if (this.selectedTool && (this.selectedTool !== toolName || this.selectedCallId !== callId)) {
        throw new Error("Gemini semantic gate received a second tool decision for one caller turn");
      }
      this.selectedTool = toolName;
      this.selectedCallId = callId;
    }

    if (providerProducedSemanticOutput(message)) {
      throw new Error(
        this.selectedTool
          ? "Gemini semantic output arrived before semantic gate release"
          : "Gemini semantic output arrived before semantic tool selection",
      );
    }
    return this.snapshot();
  }

  release() {
    if (!this.activeItemId) throw new Error("Gemini semantic gate is not armed");
    if (!this.confirmed) throw new Error("Gemini semantic gate was not confirmed by the control plane");
    if (!this.selectedTool || !this.selectedCallId) throw new Error("Gemini semantic gate cannot release before tool selection");
    this.activeItemId = null;
    this.confirmed = false;
    this.selectedTool = null;
    this.selectedCallId = null;
    return this.snapshot();
  }
}
