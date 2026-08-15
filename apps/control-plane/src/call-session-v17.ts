import { CallSession as CallSessionV16 } from "./call-session-v16";

const BaseConstructor = CallSessionV16 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV16.prototype as any;

const AGENT_TOOL_NAMES = new Set([
  "restaurant_reservation_create",
  "restaurant_reservation_query",
  "restaurant_reservation_modify",
  "restaurant_reservation_cancel",
  "restaurant_business_info",
  "restaurant_marketing_preferences",
  "restaurant_human_assistance",
  "restaurant_input_ignored",
  "restaurant_end_call",
  "restaurant_out_of_scope",
]);

type RealtimeEvent = { type?: string; name?: string; call_id?: string };
type RealtimeFunctionTool = { type: "function"; name: string; description: string; parameters: Record<string, unknown> };

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

const RESERVATION_PROPERTIES = {
  party_size: { type: "integer", minimum: 1, maximum: 100 },
  starts_at: { type: "string", description: "Fecha y hora ISO 8601. El controlador normaliza la zona local autorizada cuando procede." },
  customer_name: { type: "string" },
  customer_phone: { type: "string", description: "Solo si el usuario proporciona explícitamente un contacto distinto." },
  use_caller_phone: { type: "boolean", description: "true cuando el usuario acepta usar el número llamante como contacto." },
  duration_minutes: { type: "integer", minimum: 15, maximum: 480 },
  notes: { type: "string" },
  confirm: { type: "boolean", description: "true únicamente tras confirmación explícita de la propuesta presentada." },
  separate_tables_acceptable: { type: "boolean", description: "true solo si el usuario acepta inequívocamente mesas separadas." },
  tables_must_be_close: { type: "boolean", description: "true si exige mesas juntas o cercanas." },
} as const;

const AGENT_TOOLS: RealtimeFunctionTool[] = [
  { type: "function", name: "restaurant_reservation_create", description: "Crea o continúa una reserva. Si faltan datos, pregunta de forma natural. Cuando tengas fecha/hora y personas, llama a esta tool antes de afirmar que compruebas disponibilidad. El backend es la única autoridad sobre disponibilidad y BOOKED.", parameters: { type: "object", properties: RESERVATION_PROPERTIES, additionalProperties: false } },
  { type: "function", name: "restaurant_reservation_query", description: "Consulta las reservas futuras confirmadas asociadas de forma segura al número llamante.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { type: "function", name: "restaurant_reservation_modify", description: "Modifica una reserva existente. El backend identifica las reservas del caller, revalida disponibilidad y exige confirmación antes de escribir.", parameters: { type: "object", properties: { ...RESERVATION_PROPERTIES, selection_index: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false } },
  { type: "function", name: "restaurant_reservation_cancel", description: "Cancela una, varias o todas las reservas futuras del caller. Usa confirm=true solo después de confirmación explícita del usuario a una propuesta concreta de cancelación.", parameters: { type: "object", properties: { selection_index: { type: "integer", minimum: 1, maximum: 20 }, selection_indexes: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 20 } }, select_all: { type: "boolean" }, confirm: { type: "boolean" } }, additionalProperties: false } },
  { type: "function", name: "restaurant_business_info", description: "Obtiene información oficial del restaurante. Para peticiones relacionadas con el restaurante que requieren intervención humana usa restaurant_human_assistance; para peticiones ajenas usa restaurant_out_of_scope.", parameters: { type: "object", properties: { topics: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { type: "string", enum: ["MENU", "HOURS", "LOCATION", "SERVICES", "GENERAL_INFO"] } } }, required: ["topics"], additionalProperties: false } },
  { type: "function", name: "restaurant_marketing_preferences", description: "Consulta o modifica preferencias de promociones del número llamante. QUERY usa explicit=false y nunca modifica; GRANT, DECLINE y REVOKE requieren explicit=true.", parameters: { type: "object", properties: { action: { type: "string", enum: ["QUERY", "GRANT", "DECLINE", "REVOKE"] }, explicit: { type: "boolean" } }, required: ["action", "explicit"], additionalProperties: false } },
  { type: "function", name: "restaurant_human_assistance", description: "Escala una petición relacionada con el restaurante que necesita una persona. No implica que exista transferencia telefónica.", parameters: { type: "object", properties: { reason: { type: "string", enum: ["USER_REQUESTED_HUMAN", "TABLES_MUST_BE_CLOSE", "COMPLEX_RESERVATION", "COMPLAINT", "LOST_PROPERTY", "ALLERGY_OR_SAFETY", "ACCESSIBILITY_ARRANGEMENT", "BILLING_OR_PAYMENT_ISSUE", "EVENT_OR_LARGE_GROUP", "SYSTEM_LIMITATION", "OTHER_RESTAURANT_MATTER"] }, context_summary: { type: "string" } }, required: ["reason"], additionalProperties: false } },
  { type: "function", name: "restaurant_input_ignored", description: "Usa esta tool cuando la transcripción parece ruido, televisión, conversación de fondo, eco, palabras sueltas o un turno que no está dirigido a ti. No realiza ninguna acción y no debe producir respuesta hablada. Ante duda entre una acción destructiva y ruido/fondo, usa esta tool.", parameters: { type: "object", properties: { reason: { type: "string", enum: ["BACKGROUND_SPEECH", "TV_OR_MEDIA", "ECHO", "INCOHERENT", "NOT_DIRECTED_TO_ASSISTANT", "UNCERTAIN"] } }, required: ["reason"], additionalProperties: false } },
  { type: "function", name: "restaurant_end_call", description: "Gestiona el cierre. Si el usuario expresa inequívocamente que quiere terminar usa confirmed=true directamente. Usa confirmed=false solo si la intención es ambigua. No deduzcas cierre del silencio.", parameters: { type: "object", properties: { confirmed: { type: "boolean" } }, required: ["confirmed"], additionalProperties: false } },
  { type: "function", name: "restaurant_out_of_scope", description: "Usa esta tool para una petición claramente dirigida a ti pero ajena al restaurante. No la uses para ruido, TV o conversación de fondo: eso va a restaurant_input_ignored.", parameters: { type: "object", properties: {}, additionalProperties: false } },
];

function agentInstructions(session: any): string {
  const assistantName = typeof session.assistantName === "string" && session.assistantName.trim() ? session.assistantName.trim() : "Lucía";
  const businessName = typeof session.businessName === "string" && session.businessName.trim() ? session.businessName.trim() : "el restaurante";
  return `Eres ${assistantName}, agente telefónica de ${businessName}. Tú eres la inteligencia que interpreta el lenguaje natural y eliges las tools; ninguna señal acústica por sí sola representa intención.\n\nREGLA CENTRAL: toda interacción significativa dirigida a ti debe quedar representada por una tool antes de responder. Si una transcripción parece TV, eco, conversación de fondo, ruido o no está claramente dirigida a ti, usa restaurant_input_ignored. Ante duda entre una mutación y ruido/fondo, elige siempre restaurant_input_ignored y no realices ninguna acción.\n\nÁMBITO: atiende únicamente cuestiones relacionadas con ${businessName}. Para una petición claramente dirigida a ti pero externa usa restaurant_out_of_scope. Para asuntos legítimos del restaurante que requieren una persona usa restaurant_human_assistance.\n\nAUTORIDAD: disponibilidad, reservas, cancelaciones, modificaciones, marketing e identidad solo pueden afirmarse tras la tool correspondiente. Nunca inventes acciones ni confirmaciones.\n\nCIERRE: usa restaurant_end_call para intención real de cierre; nunca deduzcas cierre del silencio o de audio de fondo.`;
}

export class CallSession extends BaseConstructor {
  private agentToolsInstalledV17 = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok && !this.agentToolsInstalledV17) {
      this.agentToolsInstalledV17 = true;
      (this as any).send({ type: "session.update", session: { type: "realtime", instructions: agentInstructions(this as any), tools: AGENT_TOOLS, tool_choice: "auto" } });
      (this as any).diagnostics?.checkpoint?.("LUCIA_DIRECT_TOOLS_V17_ENABLED", { architecture: "agent_tools_mcp_pattern", tool_count: AGENT_TOOLS.length, mandatory_classifier: false, legacy_agent_bridge_enabled: false, tool_choice: "auto", backend_authority_preserved: true });
    }
    return response;
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) { try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; } }
    if (event?.type === "response.function_call_arguments.done" && event.name && AGENT_TOOL_NAMES.has(event.name)) {
      (this as any).diagnostics?.fail?.("UNHANDLED_PUBLIC_AGENT_TOOL", "DIRECT_TOOL_CONTROLLER_MISSING", { tool: event.name, legacy_fallback: false });
      (this as any).send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify({ ok: false, status: "ERROR", error: "DIRECT_TOOL_CONTROLLER_MISSING", retryable: false }) } });
      (this as any).send({ type: "response.create" });
      return;
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
