import { CallSession as CallSessionV10 } from "./call-session-v10";
import { publicReservationQueryResults } from "./reservation-query";
import { parseSemanticDecision } from "./semantic-router";
import { SupabaseAdapter } from "./supabase-adapter";
import { claimClassifierBootstrap, ownsClassifierBootstrap } from "./classifier-bootstrap-authority.js";

const CONVERSATION_INTENT = "conversation_intent";
const BaseConstructor = CallSessionV10 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV10.prototype as any;

type RealtimeEvent = { type?: string; name?: string; call_id?: string; arguments?: string; };

function currentMadridReference(): string {
  return new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", dateStyle: "full", timeStyle: "long" }).format(new Date());
}

function queryAwareIntentTool(): Record<string, unknown> {
  return {
    type: "function",
    name: CONVERSATION_INTENT,
    description: `Clasifica cada turno. Para RESERVATION incluye reservation y distingue operation=CREATE para crear, operation=QUERY para consultar reservas existentes y operation=CANCEL para cancelar. QUERY y CANCEL identifican siempre las reservas inicialmente mediante el caller_phone confiable del backend; nunca uses un número dictado verbalmente como prueba de identidad. Durante CANCEL, selection_index representa una opción, selection_indexes varias opciones y select_all=true únicamente cuando el usuario pide inequívocamente cancelar todas las reservas mostradas. Nunca combines esos campos. confirm=true solo tras confirmación explícita del resumen exacto de creación o cancelación presentado en un turno anterior. Para MARKETING_CONSENT incluye marketing_consent únicamente ante aceptación, rechazo o revocación explícita. Referencia temporal actual en Madrid: ${currentMadridReference()}. Nunca inventes datos.`,
    parameters: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["CONTINUE", "END_AMBIGUOUS", "END_CLEAR"] },
        data_requirement: { type: "string", enum: ["NONE", "BUSINESS_INFO", "SERVICES", "MENU", "RESERVATION", "MARKETING_CONSENT", "PROFESSIONALS", "HOURS"] },
        reason: { type: "string" },
        reservation: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["CREATE", "QUERY", "CANCEL"] },
            party_size: { type: "integer", minimum: 1, maximum: 100 },
            starts_at: { type: "string" },
            customer_name: { type: "string" },
            customer_phone: { type: "string" },
            use_caller_phone: { type: "boolean" },
            duration_minutes: { type: "integer", minimum: 15, maximum: 480 },
            notes: { type: "string" },
            selection_index: { type: "integer", minimum: 1, maximum: 20 },
            selection_indexes: { type: "array", items: { type: "integer", minimum: 1, maximum: 20 }, minItems: 1, maxItems: 20, uniqueItems: true },
            select_all: { type: "boolean" },
            confirm: { type: "boolean" },
          },
          additionalProperties: false,
        },
        marketing_consent: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["GRANT", "DECLINE", "REVOKE"] },
            explicit: { type: "boolean" },
            target_phone: { type: "string" },
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

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function requireRuntimeString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

function rawReservationOperation(argumentsJson: string | undefined): "CREATE" | "QUERY" | "CANCEL" | null {
  if (!argumentsJson?.trim()) return null;
  try {
    const root = JSON.parse(argumentsJson) as Record<string, unknown>;
    const reservation = root.reservation;
    if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) return null;
    const operation = (reservation as Record<string, unknown>).operation;
    return operation === "CREATE" || operation === "QUERY" || operation === "CANCEL" ? operation : null;
  } catch {
    return null;
  }
}

export class CallSession extends BaseConstructor {
  private querySessionUpdateV11Sent = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    if (isStart) claimClassifierBootstrap(this, "QUERY_V11");
    const response = await super.fetch(request);
    if (isStart && response.ok && ownsClassifierBootstrap(this, "QUERY_V11") && !this.querySessionUpdateV11Sent) {
      this.querySessionUpdateV11Sent = true;
      (this as any).send({ type: "session.update", session: { type: "realtime", tools: [queryAwareIntentTool()], tool_choice: "required" } });
      (this as any).diagnostics?.checkpoint?.("RESERVATION_QUERY_CLASSIFIER_SCHEMA_UPDATED", { reservation_operations: ["CREATE", "QUERY", "CANCEL"], identity_policy: "TRUSTED_CALLER_PHONE", multi_cancel_supported: true });
    }
    return response;
  }

  private getQueryAdapter(): SupabaseAdapter {
    return new SupabaseAdapter({
      SUPABASE_URL: requireRuntimeString((this as any).env?.SUPABASE_URL, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requireRuntimeString((this as any).env?.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"),
    });
  }

  private sendQueryClassifierOutput(callId: string | undefined, stage: string): void {
    if (!callId) return;
    (this as any).send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: true, action: "continue", data_requirement: "RESERVATION", reservation_operation: "QUERY", stage }) } });
  }

  private async handleReservationQuery(callId: string | undefined): Promise<void> {
    (this as any).state = "active";
    (this as any).ambiguousCount = 0;
    const tenantId = (this as any).tenantId as string | null | undefined;
    const callerPhone = (this as any).callerPhone as string | null | undefined;

    if (!tenantId || !callerPhone) {
      this.sendQueryClassifierOutput(callId, "CALLER_ID_REQUIRED");
      (this as any).diagnostics?.fail?.("RESERVATION_QUERY_BLOCKED", "TRUSTED_CALLER_PHONE_UNAVAILABLE");
      (this as any).createSpokenResponse("No inventes ni solicites un teléfono dictado como prueba de identidad. Explica brevemente que no puedes verificar automáticamente las reservas asociadas a esta llamada y que debe usarse un canal alternativo del negocio.");
      return;
    }

    const rows = await this.getQueryAdapter().listBookedReservationsByPhone(tenantId, callerPhone);
    (this as any).diagnostics?.checkpoint?.("RESERVATION_QUERY_COMPLETED", { result_count: rows.length, identity_source: "CALLER_ID", status_filter: "BOOKED" });

    if (rows.length === 0) {
      this.sendQueryClassifierOutput(callId, "NO_BOOKED_RESERVATIONS");
      (this as any).createSpokenResponse("Indica que no has encontrado reservas futuras confirmadas asociadas al mismo número desde el que está llamando. No leas el número, no inventes reservas y no pidas un número dictado para repetir la búsqueda.");
      return;
    }

    this.sendQueryClassifierOutput(callId, "RESERVATIONS_FOUND");
    (this as any).createSpokenResponse(`Informa de las reservas futuras confirmadas asociadas a esta llamada usando únicamente estos resultados verificados: ${JSON.stringify(publicReservationQueryResults(rows))}. Si hay varias, enuméralas. No leas teléfonos ni identificadores internos. Esto es solo una consulta: no modifiques ni canceles ninguna reserva.`);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) { try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; } }

    if (event?.type === "response.function_call_arguments.done" && event.name === CONVERSATION_INTENT) {
      if ((this as any).state === "closing" || (this as any).hangupStarted === true) {
        await BasePrototype.handleRealtimeMessage.call(this, data);
        return;
      }
      const semantic = parseSemanticDecision(event.arguments);
      if (semantic.intent === "CONTINUE" && semantic.dataRequirement === "RESERVATION" && rawReservationOperation(event.arguments) === "QUERY") {
        (this as any).diagnostics?.checkpoint?.("RESERVATION_OPERATION_ROUTED", { operation: "QUERY", source: "classifier", identity_source: "CALLER_ID" });
        await this.handleReservationQuery(event.call_id);
        return;
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
