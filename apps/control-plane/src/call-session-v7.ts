import { CallSession as CallSessionV6 } from "./call-session-v6";
import { parseMarketingConsentClassifierTurn } from "./marketing-consent-orchestrator";
import { parseSemanticDecision } from "./semantic-router";
import type { ToolResult } from "./tool-gateway";

const CONVERSATION_INTENT = "conversation_intent";
const MANAGE_MARKETING_CONSENT = "manage_marketing_consent";
const BaseConstructor = CallSessionV6 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV6.prototype as any;

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

function currentMadridReference(): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    dateStyle: "full",
    timeStyle: "long",
  }).format(new Date());
}

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function reservationAndMarketingAwareIntentTool(): Record<string, unknown> {
  return {
    type: "function",
    name: CONVERSATION_INTENT,
    description: `Clasifica cada turno. Para RESERVATION incluye reservation con TODOS los datos inequívocamente conocidos. Para MARKETING_CONSENT incluye marketing_consent únicamente cuando el usuario expresa de forma explícita en el turno actual que acepta, rechaza o revoca promociones. Referencia temporal actual en Madrid: ${currentMadridReference()}. Nunca inventes fecha, hora, personas, nombre, teléfono ni consentimiento. confirm=true solo si el usuario acaba de confirmar explícitamente un resumen de reserva presentado por el asistente en un turno anterior. use_caller_phone=true solo si el usuario acepta explícitamente usar el mismo número desde el que llama. Para marketing, explicit=true solo ante una manifestación inequívoca del usuario; un número dictado verbalmente puede ser target_phone pero NUNCA demuestra identidad ni CALLER_ID_MATCH.`,
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
        marketing_consent: {
          type: "object",
          description: "Solo para MARKETING_CONSENT y solo ante una decisión explícita del usuario en el turno actual. No uses este objeto para inferencias, sugerencias del asistente sin respuesta o consentimiento implícito.",
          properties: {
            action: { type: "string", enum: ["GRANT", "DECLINE", "REVOKE"] },
            explicit: { type: "boolean", description: "Debe ser true únicamente si el usuario acaba de expresar inequívocamente esta decisión." },
            target_phone: { type: "string", description: "E.164 solo si el usuario menciona explícitamente un número. No implica identidad verificada." },
          },
          required: ["action", "explicit"],
          additionalProperties: false,
        },
      },
      required: ["intent", "data_requirement", "reason"],
      additionalProperties: false,
    },
  };
}

export class CallSession extends BaseConstructor {
  private marketingSessionUpdateV7Sent = false;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isStart = request.method === "POST" && url.pathname === "/start";

    // v7 replaces only the classifier schema update. Reservation orchestration itself remains in v5/v6 unchanged.
    if (isStart) (this as any).reservationSessionUpdateV6Sent = true;

    const response = await super.fetch(request);

    if (isStart && response.ok && !this.marketingSessionUpdateV7Sent) {
      this.marketingSessionUpdateV7Sent = true;
      try {
        (this as any).send({
          type: "session.update",
          session: {
            type: "realtime",
            tools: [reservationAndMarketingAwareIntentTool()],
            tool_choice: "required",
          },
        });
        (this as any).diagnostics?.checkpoint?.("MARKETING_CONSENT_CLASSIFIER_SCHEMA_UPDATED", {
          strategy: "backend_orchestrator_v1",
          reservation_strategy_unchanged: true,
          session_type: "realtime",
        });
      } catch (error) {
        (this as any).diagnostics?.fail?.("MARKETING_CONSENT_CLASSIFIER_SCHEMA_UPDATE_FAILED", "SESSION_UPDATE_FAILED", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return response;
  }

  private sendMarketingClassifierOutput(callId: string | undefined, ok: boolean, stage: string): void {
    if (!callId) return;
    (this as any).send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({
          ok,
          action: "continue",
          data_requirement: "MARKETING_CONSENT",
          marketing_consent_orchestrator: "backend_v1",
          stage,
        }),
      },
    });
  }

  private async handleMarketingConsentTurn(argumentsJson: string | undefined, callId: string | undefined): Promise<void> {
    (this as any).state = "active";
    (this as any).ambiguousCount = 0;

    let turn;
    try {
      turn = parseMarketingConsentClassifierTurn(argumentsJson);
    } catch (error) {
      this.sendMarketingClassifierOutput(callId, false, "EXPLICIT_CONSENT_REQUIRED");
      (this as any).diagnostics?.fail?.("MARKETING_CONSENT_TURN_INVALID", "MARKETING_CONSENT_CLASSIFIER_PAYLOAD_INVALID", {
        error: error instanceof Error ? error.message : String(error),
      });
      (this as any).createSpokenResponse(
        "No modifiques ninguna preferencia de promociones. Si la intención del usuario no ha quedado inequívocamente clara, pregunta brevemente si desea recibir promociones, rechazarlas o darse de baja. La reserva y cualquier otra gestión deben continuar de forma independiente.",
      );
      return;
    }

    const tenantId = (this as any).tenantId as string | null | undefined;
    const sessionCallId = (this as any).callId as string | null | undefined;
    if (!tenantId || !sessionCallId) {
      this.sendMarketingClassifierOutput(callId, false, "SESSION_CONTEXT_UNAVAILABLE");
      (this as any).diagnostics?.fail?.("MARKETING_CONSENT_BLOCKED", "SESSION_CONTEXT_UNAVAILABLE");
      (this as any).createSpokenResponse("Indica brevemente que no se ha realizado ningún cambio en las preferencias de promociones.");
      return;
    }

    const result = await (this as any).createToolGateway().execute({
      name: MANAGE_MARKETING_CONSENT,
      arguments: {
        action: turn.flow.action,
        ...(turn.flow.targetPhone ? { target_phone: turn.flow.targetPhone } : {}),
      },
      context: { tenantId, callId: sessionCallId },
    }) as ToolResult;

    if (!result.ok) {
      this.sendMarketingClassifierOutput(callId, false, result.error);
      (this as any).diagnostics?.fail?.("MARKETING_CONSENT_BACKEND_FAILED", "TOOL_GATEWAY_RETURNED_ERROR", {
        tool: MANAGE_MARKETING_CONSENT,
        error: result.error,
      });
      (this as any).createSpokenResponse(
        result.error === "TOOL_NOT_ALLOWED"
          ? "No modifiques ninguna preferencia de promociones. Indica brevemente que esta gestión no está habilitada para este negocio. No afectes ni bloquees una reserva por este motivo."
          : "Indica brevemente que no se ha podido modificar la preferencia de promociones y que no se ha realizado ningún cambio. No afectes ni bloquees una reserva por este motivo.",
      );
      return;
    }

    const backend = result.result as Record<string, unknown>;
    const stage = typeof backend.stage === "string" ? backend.stage : "UNKNOWN";
    this.sendMarketingClassifierOutput(callId, true, stage);
    (this as any).diagnostics?.checkpoint?.("MARKETING_CONSENT_BACKEND_COMPLETED", {
      tool: MANAGE_MARKETING_CONSENT,
      stage,
      action: turn.flow.action,
      verification_method: backend.verification_method ?? null,
    });

    (this as any).createSpokenResponse(
      `Responde de forma breve usando únicamente este resultado autorizado de preferencias comerciales: ${JSON.stringify(backend)}. No leas números de teléfono en voz alta. No mezcles el consentimiento comercial con el estado de una reserva: aceptar o rechazar promociones nunca confirma, cancela ni bloquea una reserva. Si el resultado indica que otro número requiere un canal alternativo, explica solo que por seguridad esta llamada no puede modificar automáticamente ese otro número y que no se ha realizado ningún cambio; no prometas handoff humano ni una app todavía.`,
    );
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === CONVERSATION_INTENT) {
      const classification = parseSemanticDecision(event.arguments);
      if (classification.intent === "CONTINUE" && classification.dataRequirement === "MARKETING_CONSENT") {
        (this as any).diagnostics?.checkpoint?.("INTENT_CLASSIFIED", {
          intent: classification.intent,
          data_requirement: "MARKETING_CONSENT",
          orchestrator: "backend_v1",
        });
        await this.handleMarketingConsentTurn(event.arguments, event.call_id);
        return;
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
