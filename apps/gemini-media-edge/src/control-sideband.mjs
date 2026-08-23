function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}
function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} is invalid`);
  return value;
}
export function controlSessionKey(claims) {
  return `${required(claims?.tenantId, "control tenant_id")}\u0000${required(claims?.callControlId, "control call_control_id")}`;
}
export function canonicalControlCommand(value) {
  const message = object(value, "Gemini media edge control command");
  if (message.type === "TOOL_RESULT") {
    const callId = required(message.callId, "Gemini media edge control tool call id");
    const toolName = required(message.toolName, "Gemini media edge control tool name");
    if (!("output" in message)) throw new Error("Gemini media edge control tool output is required");
    return Object.freeze({ type: "TOOL_RESULT", callId, toolName, output: structuredClone(message.output) });
  }
  if (message.type === "CALLER_TURN_DECISION") {
    const itemId = required(message.itemId, "Gemini media edge caller item id");
    if (!["NORMAL", "INTERRUPT", "IGNORE"].includes(message.decision)) throw new Error("Gemini media edge caller decision is invalid");
    const responseId = message.responseId == null ? null : required(message.responseId, "Gemini media edge caller decision response id");
    if (message.decision === "INTERRUPT" && !responseId) throw new Error("Gemini media edge interruption decision requires response id");
    if (message.decision !== "INTERRUPT" && responseId) throw new Error("Gemini media edge non-interruption decision must not carry response id");
    return Object.freeze({ type: "CALLER_TURN_DECISION", itemId, decision: message.decision, responseId });
  }
  throw new Error("Gemini media edge control command type is unsupported");
}

export function sanitizeGeminiControlMessage(message) {
  const value = object(message, "Gemini Live control message");
  const sanitized = {};
  if (value.setupComplete !== undefined || value.setup_complete !== undefined) sanitized.setupComplete = {};
  const calls = value.toolCall?.functionCalls ?? value.tool_call?.function_calls;
  if (Array.isArray(calls) && calls.length) {
    sanitized.toolCall = { functionCalls: calls.map((call) => {
      if (!call || typeof call !== "object" || Array.isArray(call)) throw new Error("Gemini Live function call is invalid");
      return { id: required(call.id, "Gemini Live function call id"), name: required(call.name, "Gemini Live function call name"), ...(call.args === undefined ? {} : { args: structuredClone(call.args) }) };
    }) };
  }
  const cancellationIds = value.toolCallCancellation?.ids ?? value.tool_call_cancellation?.ids;
  if (Array.isArray(cancellationIds) && cancellationIds.length) sanitized.toolCallCancellation = { ids: cancellationIds.map((id) => required(id, "Gemini Live cancelled tool call id")) };
  const server = value.serverContent ?? value.server_content;
  if (server && typeof server === "object" && !Array.isArray(server)) {
    const content = {};
    if (server.modelTurn !== undefined || server.model_turn !== undefined) content.modelTurn = {};
    const input = server.inputTranscription ?? server.input_transcription;
    const output = server.outputTranscription ?? server.output_transcription;
    if (typeof input?.text === "string") content.inputTranscription = { text: input.text };
    if (typeof output?.text === "string") content.outputTranscription = { text: output.text };
    if ((server.generationComplete ?? server.generation_complete) === true) content.generationComplete = true;
    if ((server.turnComplete ?? server.turn_complete) === true) content.turnComplete = true;
    if (server.interrupted === true) content.interrupted = true;
    if (Object.keys(content).length) sanitized.serverContent = content;
  }
  if (value.error && typeof value.error === "object" && !Array.isArray(value.error)) {
    sanitized.error = { ...(value.error.code === undefined ? {} : { code: String(value.error.code) }), ...(typeof value.error.message === "string" ? { message: value.error.message } : {}) };
  }
  return Object.freeze(sanitized);
}
export function geminiControlEnvelope(message) { return Object.freeze({ type: "GEMINI_EVENT", message: sanitizeGeminiControlMessage(message) }); }
export function callerControlEnvelope(event) {
  const value = object(event, "Gemini caller control event");
  if (!["CALLER_SPEECH_STARTED", "CALLER_SPEECH_STOPPED", "CALLER_TRANSCRIPT_COMPLETED"].includes(value.type)) throw new Error("Gemini caller control event type is unsupported");
  return Object.freeze({ type: "CALLER_EVENT", event: structuredClone(value) });
}

export class InMemoryControlSidebandRegistry {
  constructor() { this.sessions = new Map(); }
  entry(claims) { const key = controlSessionKey(claims); let session = this.sessions.get(key); if (!session) { session = { claims, send: null, commandSink: null }; this.sessions.set(key, session); } return { key, session }; }
  cleanup(key, session) { if (this.sessions.get(key) === session && !session.send && !session.commandSink) this.sessions.delete(key); }
  attach(claims, send) {
    if (typeof send !== "function") throw new Error("Gemini media edge control sender is required");
    const { key, session } = this.entry(claims); if (session.send) throw new Error("Gemini media edge control sideband already attached"); session.send = send;
    return Object.freeze({ detach: () => { if (this.sessions.get(key) !== session) return; session.send = null; this.cleanup(key, session); } });
  }
  bindCommandSink(claims, sink) {
    if (typeof sink !== "function") throw new Error("Gemini media edge control command sink is required");
    const { key, session } = this.entry(claims); if (session.commandSink && session.commandSink !== sink) throw new Error("Gemini media edge control command sink already bound"); session.commandSink = sink;
    return Object.freeze({ detach: () => { if (this.sessions.get(key) !== session || session.commandSink !== sink) return; session.commandSink = null; this.cleanup(key, session); } });
  }
  emit(claims, event) { const session = this.sessions.get(controlSessionKey(claims)); if (!session?.send) return false; session.send(event); return true; }
  command(claims, value) { const session = this.sessions.get(controlSessionKey(claims)); if (!session?.commandSink) throw new Error("Gemini media edge control sideband is not bound to an active Gemini session"); session.commandSink(canonicalControlCommand(value)); }
  size() { return this.sessions.size; }
}
