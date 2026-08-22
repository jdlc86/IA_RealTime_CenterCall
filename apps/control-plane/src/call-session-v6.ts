import { CallSession as CallSessionV5 } from "./call-session-v5";
import { claimClassifierBootstrap, ownsClassifierBootstrap } from "./classifier-bootstrap-authority.js";

const CONVERSATION_INTENT = "conversation_intent";
const BaseConstructor = CallSessionV5 as unknown as new (...args: any[]) => any;

function currentMadridReference(): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    dateStyle: "full",
    timeStyle: "long",
  }).format(new Date());
}

function reservationAwareIntentTool(): Record<string, unknown> {
  return {
    type: "function",
    name: CONVERSATION_INTENT,
    description: `Clasifica cada turno. Para RESERVATION incluye además el objeto reservation con TODOS los datos de reserva que ya sean inequívocamente conocidos en la conversación. Referencia temporal actual en Madrid: ${currentMadridReference()}. Resuelve expresiones como hoy/mañana usando esa referencia. Nunca inventes fecha, hora, personas, nombre ni teléfono. confirm=true solo si el usuario acaba de confirmar explícitamente un resumen de reserva presentado por el asistente en un turno anterior. use_caller_phone=true solo si el usuario acepta explícitamente usar el mismo número desde el que llama.`,
    parameters: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["CONTINUE", "END_AMBIGUOUS", "END_CLEAR"] },
        data_requirement: { type: "string", enum: ["NONE", "BUSINESS_INFO", "SERVICES", "MENU", "RESERVATION", "MARKETING_CONSENT", "PROFESSIONALS", "HOURS"] },
        reason: { type: "string" },
        reservation: {
          type: "object",
          description: "Solo para RESERVATION. Incluye los datos ya conocidos de toda la conversación; omite los desconocidos.",
          properties: {
            party_size: { type: "integer", minimum: 1, maximum: 100 },
            starts_at: { type: "string", description: "ISO 8601 con zona horaria. Omite si fecha u hora siguen siendo ambiguas." },
            customer_name: { type: "string" },
            customer_phone: { type: "string", description: "E.164 solo si el usuario proporciona explícitamente un número." },
            use_caller_phone: { type: "boolean" },
            duration_minutes: { type: "integer", minimum: 15, maximum: 480 },
            notes: { type: "string" },
            confirm: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["intent", "data_requirement", "reason"],
      additionalProperties: false,
    },
  };
}

export class CallSession extends BaseConstructor {
  private reservationSessionUpdateV6Sent = false;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isStart = request.method === "POST" && url.pathname === "/start";
    if (isStart) claimClassifierBootstrap(this, "RESERVATION_V6");

    const response = await super.fetch(request);

    if (isStart && response.ok && ownsClassifierBootstrap(this, "RESERVATION_V6") && !this.reservationSessionUpdateV6Sent) {
      this.reservationSessionUpdateV6Sent = true;
      try {
        (this as any).send({
          type: "session.update",
          session: {
            type: "realtime",
            tools: [reservationAwareIntentTool()],
            tool_choice: "required",
          },
        });
        (this as any).diagnostics?.checkpoint?.("RESERVATION_CLASSIFIER_SCHEMA_UPDATED", {
          strategy: "backend_orchestrator_v1",
          session_type: "realtime",
        });
      } catch (error) {
        (this as any).diagnostics?.fail?.("RESERVATION_CLASSIFIER_SCHEMA_UPDATE_FAILED", "SESSION_UPDATE_FAILED", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return response;
  }
}
