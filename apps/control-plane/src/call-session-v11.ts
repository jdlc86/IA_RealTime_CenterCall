import { CallSession as CallSessionV10 } from "./call-session-v10";
import { parseSemanticDecision } from "./semantic-router";
import { SupabaseAdapter, type BookedReservationSummary } from "./supabase-adapter";

const CONVERSATION_INTENT = "conversation_intent";
const BaseConstructor = CallSessionV10 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV10.prototype as any;

type RealtimeEvent = { type?: string; name?: string; call_id?: string; arguments?: string; };

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

export function publicReservationQueryResults(rows: BookedReservationSummary[]): Array<Record<string, unknown>> {
  return rows.map((row, index) => ({
    option: index + 1,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    party_size: row.party_size,
    customer_name: row.customer_name,
    status: row.status,
  }));
}

export class CallSession extends BaseConstructor {
  private getQueryAdapter(): SupabaseAdapter {
    return new SupabaseAdapter({
      SUPABASE_URL: requireRuntimeString((this as any).env?.SUPABASE_URL, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requireRuntimeString((this as any).env?.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"),
    });
  }

  private sendQueryClassifierOutput(callId: string | undefined, stage: string): void {
    if (!callId) return;
    (this as any).send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ ok: true, action: "continue", data_requirement: "RESERVATION", reservation_operation: "QUERY", stage }),
      },
    });
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
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === CONVERSATION_INTENT) {
      if ((this as any).state === "closing" || (this as any).hangupStarted === true) {
        await BasePrototype.handleRealtimeMessage.call(this, data);
        return;
      }
      const semantic = parseSemanticDecision(event.arguments);
      if (semantic.intent === "CONTINUE" && semantic.dataRequirement === "RESERVATION" && rawReservationOperation(event.arguments) === "QUERY") {
        (this as any).diagnostics?.checkpoint?.("RESERVATION_OPERATION_ROUTED", { operation: "QUERY", source: "classifier" });
        await this.handleReservationQuery(event.call_id);
        return;
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
