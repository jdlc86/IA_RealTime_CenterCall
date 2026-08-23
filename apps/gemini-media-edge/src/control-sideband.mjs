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
  if (message.type !== "TOOL_RESULT") throw new Error("Gemini media edge control command type is unsupported");
  const callId = required(message.callId, "Gemini media edge control tool call id");
  const toolName = required(message.toolName, "Gemini media edge control tool name");
  if (!("output" in message)) throw new Error("Gemini media edge control tool output is required");
  return Object.freeze({ type: "TOOL_RESULT", callId, toolName, output: structuredClone(message.output) });
}

export function geminiControlEvents(message) {
  const value = object(message, "Gemini Live control message");
  const events = [];
  for (const call of value.toolCall?.functionCalls ?? value.tool_call?.function_calls ?? []) {
    if (!call || typeof call !== "object" || Array.isArray(call)) continue;
    if (typeof call.id !== "string" || !call.id.trim() || typeof call.name !== "string" || !call.name.trim()) {
      throw new Error("Gemini Live function call requires id and name");
    }
    events.push(Object.freeze({ type: "TOOL_CALL", callId: call.id.trim(), toolName: call.name.trim(), arguments: structuredClone(call.args ?? {}) }));
  }
  const server = value.serverContent ?? value.server_content;
  const input = server?.inputTranscription ?? server?.input_transcription;
  const output = server?.outputTranscription ?? server?.output_transcription;
  if (typeof input?.text === "string" && input.text) events.push(Object.freeze({ type: "INPUT_TRANSCRIPTION", text: input.text }));
  if (typeof output?.text === "string" && output.text) events.push(Object.freeze({ type: "OUTPUT_TRANSCRIPTION", text: output.text }));
  if (server?.interrupted === true) events.push(Object.freeze({ type: "INTERRUPTED" }));
  if ((server?.turnComplete ?? server?.turn_complete) === true) events.push(Object.freeze({ type: "TURN_COMPLETE" }));
  for (const id of value.toolCallCancellation?.ids ?? value.tool_call_cancellation?.ids ?? []) {
    if (typeof id === "string" && id.trim()) events.push(Object.freeze({ type: "TOOL_CALL_CANCELLED", callId: id.trim() }));
  }
  if (value.error && typeof value.error === "object") {
    events.push(Object.freeze({ type: "PROVIDER_ERROR", code: value.error.code == null ? null : String(value.error.code), message: typeof value.error.message === "string" ? value.error.message : null }));
  }
  return Object.freeze(events);
}

export class InMemoryControlSidebandRegistry {
  constructor() { this.sessions = new Map(); }

  attach(claims, send) {
    if (typeof send !== "function") throw new Error("Gemini media edge control sender is required");
    const key = controlSessionKey(claims);
    if (this.sessions.has(key)) throw new Error("Gemini media edge control sideband already attached");
    const session = { claims, send, commandSink: null };
    this.sessions.set(key, session);
    return Object.freeze({
      bindCommandSink: (sink) => {
        if (typeof sink !== "function") throw new Error("Gemini media edge control command sink is required");
        if (session.commandSink && session.commandSink !== sink) throw new Error("Gemini media edge control command sink already bound");
        session.commandSink = sink;
      },
      detach: () => { if (this.sessions.get(key) === session) this.sessions.delete(key); },
    });
  }

  emit(claims, event) {
    const session = this.sessions.get(controlSessionKey(claims));
    if (!session) return false;
    session.send(event);
    return true;
  }

  command(claims, value) {
    const session = this.sessions.get(controlSessionKey(claims));
    if (!session?.commandSink) throw new Error("Gemini media edge control sideband is not bound to an active Gemini session");
    session.commandSink(canonicalControlCommand(value));
  }

  size() { return this.sessions.size; }
}
