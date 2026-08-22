import { CallSession as CallSessionV16 } from "./call-session-v16";
import {
  adaptRealtimeProviderEvents,
  realtimeCommandPortFor,
} from "./realtime-provider-runtime.js";
import type { RealtimeFunctionToolDefinition } from "./realtime-provider-command-port.js";

const BaseConstructor = CallSessionV16 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV16.prototype as any;

const AGENT_TOOL_NAMES = new Set([
  "restaurant_reservation_create",
  "restaurant_reservation_search",
  "restaurant_reservation_query",
  "restaurant_reservation_modify",
  "restaurant_reservation_cancel",
  "restaurant_business_info",
  "restaurant_marketing_preferences",
  "restaurant_conversation",
  "restaurant_human_assistance",
  "restaurant_input_ignored",
  "restaurant_end_call",
  "restaurant_out_of_scope",
]);

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

const AGENT_TOOLS: RealtimeFunctionToolDefinition[] = [
  { type: "function", name: "restaurant_reservation_create", description: "Crea o continúa una reserva multivuelta. Úsala desde que exista una intención de reservar y también para cada respuesta contextual que aporte, corrija o confirme datos de esa reserva; el backend indicará qué falta. Cuando tengas fecha/hora y personas, llámala antes de afirmar que compruebas disponibilidad. Excepción: si el grupo menciona una necesidad de adaptación, accesibilidad, apoyo comunicativo o la presencia o necesidades de bebés, usa restaurant_human_assistance para que el equipo confirme y prepare esa necesidad antes de continuar. El backend es la única autoridad sobre disponibilidad y BOOKED.", parameters: { type: "object", properties: RESERVATION_PROPERTIES, additionalProperties: false } },
  {
    type: "function",
    name: "restaurant_reservation_search",
    description: "Busca y sugiere los turnos disponibles más cercanos para un grupo sin crear ninguna reserva. Úsala cuando el cliente no tenga una fecha/hora cerrada, pida alternativas o la hora solicitada no esté disponible. Respeta la política de asignación de mesas del backend.",
    parameters: {
      type: "object",
      properties: {
        party_size: { type: "integer", minimum: 1, maximum: 100 },
        preferred_starts_at: { type: "string", description: "Fecha/hora preferida ISO 8601 si existe." },
        from: { type: "string", description: "Inicio del rango ISO 8601. Si se omite se usa preferred_starts_at." },
        to: { type: "string", description: "Fin del rango ISO 8601. Si se omite se buscan hasta 7 días." },
        time_from: { type: "string", description: "Hora local mínima HH:MM, por ejemplo 19:00." },
        time_to: { type: "string", description: "Hora local máxima HH:MM, por ejemplo 22:30." },
        duration_minutes: { type: "integer", minimum: 15, maximum: 480 },
        step_minutes: { type: "integer", minimum: 15, maximum: 120, description: "Separación entre candidatos; normalmente 30." },
        max_results: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["party_size"],
      additionalProperties: false,
    },
  },
  { type: "function", name: "restaurant_reservation_query", description: "Consulta las reservas futuras confirmadas asociadas de forma segura al número llamante.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { type: "function", name: "restaurant_reservation_modify", description: "Modifica una reserva existente. El backend identifica las reservas del caller, revalida disponibilidad y exige confirmación antes de escribir.", parameters: { type: "object", properties: { ...RESERVATION_PROPERTIES, selection_index: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false } },
  { type: "function", name: "restaurant_reservation_cancel", description: "Cancela una, varias o todas las reservas futuras del caller. Usa confirm=true solo después de confirmación explícita del usuario a una propuesta concreta de cancelación.", parameters: { type: "object", properties: { selection_index: { type: "integer", minimum: 1, maximum: 20 }, selection_indexes: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 20 } }, select_all: { type: "boolean" }, confirm: { type: "boolean" } }, additionalProperties: false } },
  { type: "function", name: "restaurant_business_info", description: "Obtiene información oficial del restaurante. Para peticiones relacionadas con el restaurante que requieren intervención humana usa restaurant_human_assistance; para peticiones ajenas usa restaurant_out_of_scope.", parameters: { type: "object", properties: { topics: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { type: "string", enum: ["MENU", "HOURS", "LOCATION", "SERVICES", "GENERAL_INFO"] } } }, required: ["topics"], additionalProperties: false } },
  { type: "function", name: "restaurant_marketing_preferences", description: "Consulta o modifica preferencias de promociones del número llamante. QUERY usa explicit=false y nunca modifica; GRANT, DECLINE y REVOKE requieren explicit=true.", parameters: { type: "object", properties: { action: { type: "string", enum: ["QUERY", "GRANT", "DECLINE", "REVOKE"] }, explicit: { type: "boolean" } }, required: ["action", "explicit"], additionalProperties: false } },
  { type: "function", name: "restaurant_conversation", description: "Representa un turno significativo dirigido a ti que debe resolverse conversando de forma natural y no requiere consultar datos, ejecutar una acción, escalar a una persona ni terminar la llamada. Interpreta la intención usando todo el contexto. Incluye preguntas, objeciones o solicitudes de explicación sobre lo que acabas de decir. No la uses para recopilar ni conservar datos de una operación activa: una respuesta que continúa una reserva, modificación o cancelación pertenece a la tool de esa operación aunque el turno aislado sea breve. Una duda sobre accesibilidad, adaptaciones, apoyo comunicativo o necesidades de bebés y menores requiere confirmación fiable del restaurante y usa restaurant_human_assistance, aunque todavía no haya comenzado una reserva. No la uses para ruido o habla de fondo.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { type: "function", name: "restaurant_human_assistance", description: "Escala una petición relacionada con el restaurante que necesita confirmación o atención de una persona. No implica que exista transferencia telefónica y nunca autoriza a transferir sin consentimiento del usuario. Úsala directamente, incluso antes de iniciar una reserva, para preguntas o necesidades de accesibilidad, entrada o espacio adaptado, movilidad, apoyo sensorial o comunicativo, acompañamiento y para la presencia, equipamiento o preparación de bebés. En esos casos no prometas ni niegues una adaptación, no infieras diagnósticos o limitaciones y no presentes a la persona ni su necesidad como un problema: explica con respeto que el equipo debe confirmarlo para dar una respuesta fiable y preparar bien la visita. Para reservas ordinarias o grupos grandes, no la elijas por inferencia propia: llama primero a la tool de reserva y espera a que el backend indique que requiere intervención humana, salvo que el usuario pida explícitamente hablar con una persona.", parameters: { type: "object", properties: { reason: { type: "string", enum: ["USER_REQUESTED_HUMAN", "TABLES_MUST_BE_CLOSE", "COMPLEX_RESERVATION", "COMPLAINT", "LOST_PROPERTY", "ALLERGY_OR_SAFETY", "ACCESSIBILITY_ARRANGEMENT", "CHILD_OR_INFANT_ACCOMMODATION", "BILLING_OR_PAYMENT_ISSUE", "EVENT_OR_LARGE_GROUP", "SYSTEM_LIMITATION", "OTHER_RESTAURANT_MATTER"] }, context_summary: { type: "string" } }, required: ["reason"], additionalProperties: false } },
  { type: "function", name: "restaurant_input_ignored", description: "Usa esta tool únicamente cuando el contexto completo indique que la transcripción es ruido, televisión, conversación de fondo, eco, contenido incoherente o un turno no dirigido a ti. Una respuesta inteligible a tu última pregunta, o una pregunta, objeción o petición de explicación sobre lo que acabas de decir, está dirigida a ti y nunca debe silenciarse con esta tool. No realiza ninguna acción ni produce respuesta hablada. Ante duda entre una mutación y auténtico ruido/fondo, evita la mutación.", parameters: { type: "object", properties: { reason: { type: "string", enum: ["BACKGROUND_SPEECH", "TV_OR_MEDIA", "ECHO", "INCOHERENT", "NOT_DIRECTED_TO_ASSISTANT", "UNCERTAIN"] } }, required: ["reason"], additionalProperties: false } },
  { type: "function", name: "restaurant_end_call", description: "Gestiona el cierre. Si el usuario expresa inequívocamente que quiere terminar usa confirmed=true directamente. Usa confirmed=false solo si la intención es ambigua. No deduzcas cierre del silencio.", parameters: { type: "object", properties: { confirmed: { type: "boolean" } }, required: ["confirmed"], additionalProperties: false } },
  { type: "function", name: "restaurant_out_of_scope", description: "Usa esta tool para una petición claramente dirigida a ti pero ajena al restaurante. Las preguntas sobre accesibilidad, adaptaciones, apoyo comunicativo, bebés o menores durante una visita pertenecen al restaurante y nunca están fuera de ámbito. No la uses para ruido, TV o conversación de fondo: eso va a restaurant_input_ignored.", parameters: { type: "object", properties: {}, additionalProperties: false } },
];

function agentInstructions(session: any): string {
  const assistantName = typeof session.assistantName === "string" && session.assistantName.trim() ? session.assistantName.trim() : "Lucía";
  const businessName = typeof session.businessName === "string" && session.businessName.trim() ? session.businessName.trim() : "el restaurante";
  return `Eres ${assistantName}, agente telefónica de ${businessName}. Tú eres la inteligencia que interpreta el lenguaje natural y eliges las tools; ninguna señal acústica por sí sola representa intención.\n\nREGLA CENTRAL: toda interacción significativa dirigida a ti debe quedar representada por una tool antes de responder. Si el turno es una comunicación natural dirigida a ti pero no requiere datos ni una acción operativa, usa restaurant_conversation y responde comprendiendo el contexto completo. Si una transcripción parece TV, eco, conversación de fondo, ruido o no está claramente dirigida a ti, usa restaurant_input_ignored. Ante duda entre una mutación y ruido/fondo, elige siempre restaurant_input_ignored y no realices ninguna acción.\n\nRESERVAS: si el cliente no sabe exactamente cuándo reservar, pide criterios básicos y usa restaurant_reservation_search para proponer opciones reales. Si una hora concreta no está disponible, ofrece buscar alternativas. La asignación automática de mesas solo puede desperdiciar como máximo un asiento total; si el backend indica que la configuración de mesas necesita una persona, no rechaces ni canceles nada y ofrece asistencia humana.\n\nÁMBITO: atiende únicamente cuestiones relacionadas con ${businessName}. Para una petición claramente dirigida a ti pero externa usa restaurant_out_of_scope. Para asuntos legítimos del restaurante que requieren una persona usa restaurant_human_assistance.\n\nAUTORIDAD: disponibilidad, reservas, cancelaciones, modificaciones, marketing e identidad solo pueden afirmarse tras la tool correspondiente. Nunca inventes acciones ni confirmaciones.\n\nCIERRE: usa restaurant_end_call para intención real de cierre; nunca deduzcas cierre del silencio o de audio de fondo.`;
}

export class CallSession extends BaseConstructor {
  private agentToolsInstalledV17 = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok && !this.agentToolsInstalledV17) {
      this.agentToolsInstalledV17 = true;
      realtimeCommandPortFor(this as any).updateSessionPolicy({
        instructions: agentInstructions(this as any),
        tools: AGENT_TOOLS,
        toolChoice: "AUTO",
      });
      (this as any).diagnostics?.checkpoint?.("LUCIA_DIRECT_TOOLS_V17_ENABLED", {
        architecture: "agent_tools_mcp_pattern",
        tool_count: AGENT_TOOLS.length,
        mandatory_classifier: false,
        legacy_agent_bridge_enabled: false,
        tool_choice: "auto",
        backend_authority_preserved: true,
        provider_command_port: true,
      });
    }
    return response;
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const toolEvent = adaptRealtimeProviderEvents(data).find(
      (event) => event.type === "SEMANTIC_TOOL_SELECTED" && AGENT_TOOL_NAMES.has(event.name),
    );
    if (toolEvent?.type === "SEMANTIC_TOOL_SELECTED") {
      if (toolEvent.name === "restaurant_conversation") {
        const realtime = realtimeCommandPortFor(this as any);
        realtime.submitToolResult({
          callId: toolEvent.callId,
          toolName: toolEvent.name,
          output: {
            ok: true,
            status: "CONVERSATION",
            mutation: false,
            instruction: "Responde ahora al último turno del usuario de forma breve, natural y coherente con todo el contexto. No inventes datos del restaurante ni conviertas este intercambio conversacional en una operación, una transferencia o un cierre.",
          },
        });
        realtime.createDefaultResponse();
        (this as any).diagnostics?.checkpoint?.("NATURAL_CONVERSATION_TURN_ACCEPTED_V17", {
          model_owned_interpretation: true,
          mutation: false,
          deterministic_phrase_matching: false,
        });
        return;
      }
      (this as any).diagnostics?.fail?.("UNHANDLED_PUBLIC_AGENT_TOOL", "DIRECT_TOOL_CONTROLLER_MISSING", {
        tool: toolEvent.name,
        legacy_fallback: false,
      });
      const realtime = realtimeCommandPortFor(this as any);
      realtime.submitToolResult({
        callId: toolEvent.callId,
        toolName: toolEvent.name,
        output: { ok: false, status: "ERROR", error: "DIRECT_TOOL_CONTROLLER_MISSING", retryable: false },
      });
      realtime.createDefaultResponse();
      return;
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
