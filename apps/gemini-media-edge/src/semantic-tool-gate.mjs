function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function providerToolCalls(message) {
  const calls = message?.toolCall?.functionCalls ?? message?.tool_call?.function_calls;
  return Array.isArray(calls) ? calls : [];
}

function providerServerContent(message) {
  const server = message?.serverContent ?? message?.server_content;
  return server && typeof server === "object" && !Array.isArray(server) ? server : null;
}

function providerProducedSemanticOutput(message) {
  const server = providerServerContent(message);
  if (!server) return false;
  const modelTurn = server.modelTurn ?? server.model_turn;
  const output = server.outputTranscription ?? server.output_transcription;
  return modelTurn !== undefined || (typeof output?.text === "string" && output.text.trim().length > 0);
}

function providerTurnComplete(message) {
  const server = providerServerContent(message);
  return Boolean(server && (server.turnComplete === true || server.turn_complete === true));
}

/**
 * Product-owned enforcement for Gemini's one-tool semantic decision invariant.
 *
 * Caller audio is committed to Live only after preArm() succeeds. An isolated,
 * call-scoped classifier may then preselect the expected product tool before Live
 * sees the caller audio. Only the built-in conversation route may authorize direct
 * model output without a provider toolCall; data/action routes still require the
 * real correlated Gemini function call and authenticated control-plane release.
 *
 * If Live later emits a toolCall it must agree with the isolated preselection.
 * A conflicting call, ambiguous output, or direct output for a governed tool fails
 * closed. Provider call ids are never synthesized by the preselection path.
 */
export class GeminiSemanticToolGate {
  constructor() {
    this.activeItemId = null;
    this.confirmed = false;
    this.preselectedTool = null;
    this.directModelOutputAllowed = false;
    this.directModelOutputObserved = false;
    this.selectedTool = null;
    this.selectedCallId = null;
  }

  snapshot() {
    return Object.freeze({
      armed: this.activeItemId !== null,
      activeItemId: this.activeItemId,
      confirmed: this.confirmed,
      preselectedTool: this.preselectedTool,
      directModelOutputAllowed: this.directModelOutputAllowed,
      directModelOutputObserved: this.directModelOutputObserved,
      selectedTool: this.selectedTool,
      selectedCallId: this.selectedCallId,
    });
  }

  reset() {
    this.activeItemId = null;
    this.confirmed = false;
    this.preselectedTool = null;
    this.directModelOutputAllowed = false;
    this.directModelOutputObserved = false;
    this.selectedTool = null;
    this.selectedCallId = null;
    return this.snapshot();
  }

  preArm(itemId) {
    const id = required(itemId, "Gemini semantic gate caller item id");
    if (this.activeItemId && this.activeItemId !== id) {
      throw new Error(`Gemini semantic gate already owns caller item ${this.activeItemId}`);
    }
    if (!this.activeItemId) {
      this.activeItemId = id;
      this.confirmed = false;
      this.preselectedTool = null;
      this.directModelOutputAllowed = false;
      this.directModelOutputObserved = false;
      this.selectedTool = null;
      this.selectedCallId = null;
    }
    return this.snapshot();
  }

  preselect(itemId, selection) {
    const id = required(itemId, "Gemini semantic gate preselection caller item id");
    if (!this.activeItemId || this.activeItemId !== id) {
      throw new Error("Gemini semantic gate preselection item identity mismatch");
    }
    if (this.preselectedTool || this.selectedTool || this.directModelOutputObserved) {
      throw new Error("Gemini semantic gate preselection is already fixed for this caller turn");
    }
    const selectedTool = required(selection?.selectedTool, "Gemini semantic gate preselected tool");
    if (typeof selection?.directModelOutputAllowed !== "boolean") {
      throw new Error("Gemini semantic gate direct-output authority is required");
    }
    this.preselectedTool = selectedTool;
    this.directModelOutputAllowed = selection.directModelOutputAllowed;
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
      if (this.preselectedTool && this.preselectedTool !== toolName) {
        throw new Error("Gemini semantic gate provider tool conflicts with isolated preselection");
      }
      if (this.selectedTool && (this.selectedTool !== toolName || this.selectedCallId !== callId)) {
        throw new Error("Gemini semantic gate received a second tool decision for one caller turn");
      }
      this.selectedTool = toolName;
      this.selectedCallId = callId;
    }

    if (providerProducedSemanticOutput(message)) {
      if (this.selectedTool) {
        throw new Error("Gemini semantic output arrived before semantic gate release");
      }
      if (!this.preselectedTool) {
        throw new Error("Gemini semantic output arrived before semantic tool selection");
      }
      if (!this.confirmed) {
        throw new Error("Gemini semantic output arrived before control-plane gate confirmation");
      }
      if (!this.directModelOutputAllowed) {
        throw new Error("Gemini semantic output bypassed a governed preselected tool");
      }
      this.directModelOutputObserved = true;
    }

    if (providerTurnComplete(message) && this.directModelOutputObserved && !this.selectedTool) {
      return this.reset();
    }
    return this.snapshot();
  }

  rejectProvisionalSelection(callId, toolName) {
    if (!this.activeItemId) throw new Error("Gemini semantic gate is not armed");
    const id = required(callId, "Gemini semantic gate rejected function call id");
    const name = required(toolName, "Gemini semantic gate rejected function name");
    if (!this.selectedCallId || !this.selectedTool) {
      throw new Error("Gemini semantic gate has no provisional tool selection to reject");
    }
    if (this.selectedCallId !== id || this.selectedTool !== name) {
      throw new Error("Gemini semantic gate rejected tool identity mismatch");
    }
    this.preselectedTool = null;
    this.directModelOutputAllowed = false;
    this.directModelOutputObserved = false;
    this.selectedTool = null;
    this.selectedCallId = null;
    return this.snapshot();
  }

  release() {
    if (!this.activeItemId) throw new Error("Gemini semantic gate is not armed");
    if (!this.confirmed) throw new Error("Gemini semantic gate was not confirmed by the control plane");
    if (!this.selectedTool || !this.selectedCallId) throw new Error("Gemini semantic gate cannot release before tool selection");
    return this.reset();
  }
}
