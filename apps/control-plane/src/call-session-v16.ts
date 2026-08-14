import { CallSession as CallSessionV15 } from "./call-session-v15";
import { SupabaseAdapter, type BookedReservationSummary } from "./supabase-adapter";
import { SupabaseMarketingConsentStore } from "./marketing-consent-store";
import type { ToolGateway, ToolRequest, ToolResult } from "./tool-gateway";

const BaseConstructor = CallSessionV15 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV15.prototype as any;
const CONVERSATION_INTENT = "conversation_intent";
const CHECK_RESERVATION_AVAILABILITY = "check_reservation_availability";
const MANAGE_RESERVATION = "manage_reservation";

type RealtimeEvent = { type?: string; name?: string; call_id?: string; arguments?: string };
type TablePlanRow = {
  allocation_mode: "SINGLE" | "MULTI_EXACT";
  plan_order: number;
  table_id: string;
  table_code: string;
  table_name: string;
  min_capacity: number;
  max_capacity: number;
  starts_at: string;
  ends_at: string;
};
type ModifyPatch = {
  partySize?: number;
  startsAt?: string;
  customerName?: string;
  durationMinutes?: number;
  notes?: string;
};

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
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function optionalBoolean(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function optionalNumber(value: unknown): number | undefined { return Number.isInteger(value) ? value as number : undefined; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function durationMinutes(row: BookedReservationSummary): number {
  return Math.max(15, Math.round((Date.parse(row.ends_at) - Date.parse(row.starts_at)) / 60000));
}
function publicReservation(row: BookedReservationSummary, index: number): Record<string, unknown> {
  return { option: index + 1, reservation_code: row.reservation_code, starts_at: row.starts_at, party_size: row.party_size, customer_name: row.customer_name };
}

export class CallSession extends BaseConstructor {
  private separateTablesAcceptableV16: boolean | undefined;
  private tablesMustBeCloseV16 = false;
  private multitablePlanV16: TablePlanRow[] | null = null;
  private multitableKeyV16: string | null = null;

  private modifyRequestedV16 = false;
  private modifyCandidatesV16: BookedReservationSummary[] | null = null;
  private modifySelectedV16: BookedReservationSummary | null = null;
  private modifyPatchV16: ModifyPatch = {};
  private modifySelectionIndexV16: number | undefined;
  private modifyConfirmV16 = false;
  private modifyConfirmationFingerprintV16: string | null = null;

  private marketingQueryRequestedV16 = false;

  private adapterV16(): SupabaseAdapter {
    return new SupabaseAdapter({
      SUPABASE_URL: requireRuntimeString((this as any).env?.SUPABASE_URL, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requireRuntimeString((this as any).env?.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"),
    });
  }

  private async rpcV16<T>(name: string, body: Record<string, unknown>): Promise<T[]> {
    const baseUrl = requireRuntimeString((this as any).env?.SUPABASE_URL, "SUPABASE_URL").replace(/\/+$/, "");
    const key = requireRuntimeString((this as any).env?.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
    const response = await fetch(`${baseUrl}/rest/v1/rpc/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Supabase RPC ${name} failed with HTTP ${response.status}: ${raw.slice(0, 250)}`);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`Supabase RPC ${name} returned invalid payload`);
    return parsed as T[];
  }

  private captureStructuredTurnV16(argumentsJson: string | undefined): void {
    if (!argumentsJson?.trim()) return;
    let root: Record<string, unknown>;
    try { root = asObject(JSON.parse(argumentsJson)); } catch { return; }
    const intent = root.intent;
    const reservation = asObject(root.reservation);

    if (intent === "CREATE_RESERVATION") {
      this.modifyRequestedV16 = false;
      const separate = optionalBoolean(reservation.separate_tables_acceptable);
      const close = optionalBoolean(reservation.tables_must_be_close);
      if (separate !== undefined) this.separateTablesAcceptableV16 = separate;
      if (close !== undefined) this.tablesMustBeCloseV16 = close;
    } else if (intent === "MODIFY_RESERVATION") {
      this.modifyRequestedV16 = true;
      this.modifyConfirmV16 = reservation.confirm === true;
      this.modifySelectionIndexV16 = optionalNumber(reservation.selection_index);
      const separate = optionalBoolean(reservation.separate_tables_acceptable);
      const close = optionalBoolean(reservation.tables_must_be_close);
      if (separate !== undefined) this.separateTablesAcceptableV16 = separate;
      if (close !== undefined) this.tablesMustBeCloseV16 = close;
      const patch: ModifyPatch = {
        partySize: optionalNumber(reservation.party_size),
        startsAt: optionalString(reservation.starts_at),
        customerName: optionalString(reservation.customer_name),
        durationMinutes: optionalNumber(reservation.duration_minutes),
        notes: optionalString(reservation.notes),
      };
      for (const [key, value] of Object.entries(patch)) if (value !== undefined) (this.modifyPatchV16 as Record<string, unknown>)[key] = value;
    } else if (intent === "QUERY_RESERVATION" || intent === "CANCEL_RESERVATION") {
      this.modifyRequestedV16 = false;
      this.resetModifyV16();
    }

    if (intent === "MARKETING_CONSENT") {
      const marketing = asObject(root.marketing_consent);
      this.marketingQueryRequestedV16 = marketing.action === "QUERY";
    } else {
      this.marketingQueryRequestedV16 = false;
    }
  }

  private resetModifyV16(): void {
    this.modifyCandidatesV16 = null;
    this.modifySelectedV16 = null;
    this.modifyPatchV16 = {};
    this.modifySelectionIndexV16 = undefined;
    this.modifyConfirmV16 = false;
    this.modifyConfirmationFingerprintV16 = null;
  }

  private async tablePlanV16(partySize: number, startsAt: string, duration: number, excludeReservationId: string | null = null): Promise<TablePlanRow[]> {
    const tenantId = requireRuntimeString((this as any).tenantId, "tenant_id");
    return this.rpcV16<TablePlanRow>("check_restaurant_table_plan", {
      p_tenant_id: tenantId,
      p_starts_at: startsAt,
      p_party_size: partySize,
      p_duration_minutes: duration,
      p_exclude_reservation_id: excludeReservationId,
    });
  }

  private compositionV16(plan: TablePlanRow[]): string {
    return plan.map((row) => `${row.max_capacity} personas`).join(" + ");
  }

  private createSpokenResponse(instructions: string): void {
    if (this.multitablePlanV16?.length && instructions.includes("No hay disponibilidad para la hora solicitada")) {
      if (this.tablesMustBeCloseV16 || this.separateTablesAcceptableV16 === false) {
        BasePrototype.createSpokenResponse.call(this,
          `Hay una combinación exacta de mesas disponibles (${this.compositionV16(this.multitablePlanV16)}), pero el sistema no puede garantizar que estén juntas o cercanas. Explica que esta configuración necesita gestión de una persona del restaurante y que no se ha creado ninguna reserva. No prometas una transferencia automática si no existe una herramienta de transferencia activa.`);
        return;
      }
      if (this.separateTablesAcceptableV16 !== true) {
        BasePrototype.createSpokenResponse.call(this,
          `No hay una mesa única adecuada, pero sí hay disponibilidad exacta repartiendo el grupo entre mesas completas (${this.compositionV16(this.multitablePlanV16)}). Pregunta claramente si les da igual estar en mesas separadas. No confirmes ninguna reserva todavía y no prometas que las mesas estarán cerca.`);
        return;
      }
    }
    BasePrototype.createSpokenResponse.call(this, instructions);
  }

  private createToolGateway(): ToolGateway {
    const baseGateway = BasePrototype.createToolGateway.call(this) as ToolGateway;
    return {
      execute: async (request: ToolRequest): Promise<ToolResult> => {
        if (request.name === CHECK_RESERVATION_AVAILABILITY) {
          const base = await baseGateway.execute(request) as ToolResult;
          if (!base.ok) return base;
          const result = base.result as Record<string, unknown>;
          if (result.requested_available === true) {
            this.multitablePlanV16 = null;
            this.multitableKeyV16 = null;
            return base;
          }
          const args = asObject(request.arguments);
          const partySize = optionalNumber(args.party_size);
          const startsAt = optionalString(args.starts_at);
          const duration = optionalNumber(args.duration_minutes) ?? 90;
          if (!partySize || !startsAt) return base;
          const plan = await this.tablePlanV16(partySize, startsAt, duration);
          if (!plan.length || plan[0]?.allocation_mode !== "MULTI_EXACT") return base;
          this.multitablePlanV16 = plan;
          this.multitableKeyV16 = JSON.stringify({ party_size: partySize, starts_at: startsAt, duration_minutes: duration });
          (this as any).diagnostics?.checkpoint?.("RESERVATION_MULTITABLE_PLAN_FOUND", {
            table_count: plan.length,
            capacities: plan.map((row) => row.max_capacity),
            exact_capacity: plan.reduce((sum, row) => sum + row.max_capacity, 0),
          });
          if (this.separateTablesAcceptableV16 === true && !this.tablesMustBeCloseV16) {
            return {
              ...base,
              result: {
                ...result,
                requested_available: true,
                allocation_mode: "MULTI_EXACT",
                requested_candidates: plan.map((row) => ({ starts_at: row.starts_at, table_code: row.table_code, table_name: row.table_name, max_capacity: row.max_capacity })),
              },
            } as ToolResult;
          }
          return base;
        }

        if (request.name === MANAGE_RESERVATION && this.multitablePlanV16?.length && this.separateTablesAcceptableV16 === true && !this.tablesMustBeCloseV16) {
          const args = asObject(request.arguments);
          const partySize = optionalNumber(args.party_size);
          const startsAt = optionalString(args.starts_at);
          const customerName = optionalString(args.customer_name);
          const customerPhone = optionalString(args.customer_phone);
          const duration = optionalNumber(args.duration_minutes) ?? 90;
          const notes = optionalString(args.notes);
          const key = partySize && startsAt ? JSON.stringify({ party_size: partySize, starts_at: startsAt, duration_minutes: duration }) : null;
          if (!partySize || !startsAt || !customerName || !customerPhone || key !== this.multitableKeyV16) return baseGateway.execute(request) as Promise<ToolResult>;
          if (args.confirm !== true) {
            return {
              ok: true,
              tool: MANAGE_RESERVATION,
              tenantId: request.context.tenantId,
              result: { stage: "CONFIRM_RESERVATION", party_size: partySize, starts_at: startsAt, customer_name: customerName, allocation_mode: "MULTI_EXACT", tables: this.multitablePlanV16.map((row) => ({ table_name: row.table_name, capacity: row.max_capacity })) },
            } as ToolResult;
          }
          try {
            const rows = await this.rpcV16<Record<string, unknown>>("create_restaurant_reservation_multi", {
              p_tenant_id: request.context.tenantId,
              p_customer_name: customerName,
              p_customer_phone: customerPhone,
              p_party_size: partySize,
              p_starts_at: startsAt,
              p_duration_minutes: duration,
              p_notes: notes ?? null,
              p_source: "voice",
            });
            if (!rows.length) throw new Error("empty booking result");
            const code = rows[0]?.reservation_code;
            this.multitablePlanV16 = null;
            this.multitableKeyV16 = null;
            return {
              ok: true,
              tool: MANAGE_RESERVATION,
              tenantId: request.context.tenantId,
              result: { stage: "BOOKED", reservation_code: code, party_size: partySize, starts_at: startsAt, allocation_mode: "MULTI_EXACT", tables: rows.map((row) => ({ table_name: row.table_name, table_code: row.table_code })) },
            } as ToolResult;
          } catch (error) {
            return { ok: false, tool: MANAGE_RESERVATION, tenantId: request.context.tenantId, error: "EXECUTION_FAILED", message: error instanceof Error ? error.message : String(error) } as ToolResult;
          }
        }

        return baseGateway.execute(request) as Promise<ToolResult>;
      },
    } as ToolGateway;
  }

  private async handleMarketingConsentTurn(argumentsJson: string | undefined, callId: string | undefined): Promise<void> {
    if (!this.marketingQueryRequestedV16) {
      return BasePrototype.handleMarketingConsentTurn.call(this, argumentsJson, callId);
    }
    this.marketingQueryRequestedV16 = false;
    const tenantId = (this as any).tenantId as string | null | undefined;
    const callerPhone = (this as any).callerPhone as string | null | undefined;
    if (!tenantId || !callerPhone) {
      (this as any).sendMarketingClassifierOutput?.(callId, false, "CALLER_ID_REQUIRED");
      (this as any).createSpokenResponse("Explica que no puedes consultar con seguridad el estado de promociones porque no está disponible la identidad del número llamante. No modifiques ninguna preferencia. ¿Necesitas algo más en lo que pueda ayudarte?");
      return;
    }
    const store = new SupabaseMarketingConsentStore({
      SUPABASE_URL: requireRuntimeString((this as any).env?.SUPABASE_URL, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requireRuntimeString((this as any).env?.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"),
    });
    const status = await store.getLatestStatus(tenantId, callerPhone);
    (this as any).sendMarketingClassifierOutput?.(callId, true, "MARKETING_STATUS_QUERY");
    (this as any).diagnostics?.checkpoint?.("MARKETING_STATUS_QUERY_COMPLETED", { status: status ?? "NO_RECORD", identity_source: "CALLER_ID", changed: false });
    const meaning = status === "VERIFIED"
      ? "está dado de alta para recibir promociones"
      : status === "REVOKED"
        ? "está dado de baja de promociones"
        : status === "DECLINED"
          ? "consta que rechazó recibir promociones"
          : "no consta un consentimiento activo para recibir promociones";
    (this as any).createSpokenResponse(`Resultado autorizado de consulta de promociones: el número desde el que llama ${meaning}. Esto es solo una consulta y no modifica ninguna preferencia. No leas el número en voz alta. Después pregunta exactamente: ¿Necesitas algo más en lo que pueda ayudarte?`);
  }

  private async handleReservationQuery(callId: string | undefined): Promise<void> {
    if (!this.modifyRequestedV16) return BasePrototype.handleReservationQuery.call(this, callId);
    const tenantId = requireRuntimeString((this as any).tenantId, "tenant_id");
    const callerPhone = requireRuntimeString((this as any).callerPhone, "caller_phone");

    if (!this.modifyCandidatesV16) this.modifyCandidatesV16 = await this.adapterV16().listBookedReservationsByPhone(tenantId, callerPhone);
    if (this.modifyCandidatesV16.length === 0) {
      this.resetModifyV16();
      (this as any).createSpokenResponse("Indica que no hay reservas futuras confirmadas asociadas a esta llamada que puedan modificarse. Después pregunta exactamente: ¿Necesitas algo más en lo que pueda ayudarte?");
      return;
    }

    if (!this.modifySelectedV16) {
      if (this.modifyCandidatesV16.length === 1) this.modifySelectedV16 = this.modifyCandidatesV16[0];
      else if (this.modifySelectionIndexV16 && this.modifySelectionIndexV16 <= this.modifyCandidatesV16.length) this.modifySelectedV16 = this.modifyCandidatesV16[this.modifySelectionIndexV16 - 1];
      else {
        (this as any).createSpokenResponse(`El usuario tiene varias reservas. Presenta únicamente estas opciones verificadas de forma numerada y pregunta cuál desea modificar: ${JSON.stringify(this.modifyCandidatesV16.map(publicReservation))}. No modifiques nada todavía.`);
        return;
      }
    }

    const current = this.modifySelectedV16;
    const hasChange = Object.values(this.modifyPatchV16).some((value) => value !== undefined);
    if (!hasChange) {
      (this as any).createSpokenResponse(`La reserva seleccionada es ${JSON.stringify(publicReservation(current, 0))}. Pregunta qué desea cambiar: fecha/hora, número de personas, nombre o notas. No modifiques nada todavía.`);
      return;
    }

    const partySize = this.modifyPatchV16.partySize ?? current.party_size;
    const startsAt = this.modifyPatchV16.startsAt ?? current.starts_at;
    const duration = this.modifyPatchV16.durationMinutes ?? durationMinutes(current);
    const customerName = this.modifyPatchV16.customerName ?? current.customer_name;
    const plan = await this.tablePlanV16(partySize, startsAt, duration, current.id);
    if (!plan.length) {
      this.modifyConfirmationFingerprintV16 = null;
      (this as any).createSpokenResponse("No hay disponibilidad verificada para aplicar ese cambio. Indícalo claramente y pregunta si quiere probar otra fecha, hora o número de personas. La reserva original sigue intacta.");
      return;
    }

    if (plan[0].allocation_mode === "MULTI_EXACT") {
      if (this.tablesMustBeCloseV16 || this.separateTablesAcceptableV16 === false) {
        this.modifyConfirmationFingerprintV16 = null;
        (this as any).createSpokenResponse(`Para aplicar el cambio hay disponibilidad solo repartiendo el grupo entre mesas completas (${this.compositionV16(plan)}), pero no se puede garantizar cercanía. Explica que necesita gestión de una persona del restaurante; la reserva original sigue intacta y no prometas una transferencia automática sin una tool activa.`);
        return;
      }
      if (this.separateTablesAcceptableV16 !== true) {
        this.modifyConfirmationFingerprintV16 = null;
        (this as any).createSpokenResponse(`Para aplicar el cambio hay disponibilidad exacta repartiendo el grupo entre mesas completas (${this.compositionV16(plan)}). Pregunta si les da igual quedar en mesas separadas. No modifiques la reserva todavía ni prometas cercanía.`);
        return;
      }
    }

    const fingerprint = JSON.stringify({ reservation_id: current.id, party_size: partySize, starts_at: startsAt, duration_minutes: duration, customer_name: customerName, notes: this.modifyPatchV16.notes ?? null, allocation_mode: plan[0].allocation_mode });
    if (this.modifyConfirmV16 && this.modifyConfirmationFingerprintV16 === fingerprint) {
      try {
        const rows = await this.rpcV16<Record<string, unknown>>("modify_restaurant_reservation", {
          p_tenant_id: tenantId,
          p_reservation_id: current.id,
          p_caller_phone: callerPhone,
          p_party_size: partySize,
          p_starts_at: startsAt,
          p_duration_minutes: duration,
          p_customer_name: customerName,
          p_notes: this.modifyPatchV16.notes ?? null,
        });
        if (!rows.length) throw new Error("empty modify result");
        (this as any).diagnostics?.checkpoint?.("RESERVATION_MODIFIED_EVIDENCE", { reservation_code: current.reservation_code, allocation_mode: rows[0]?.allocation_mode ?? null, table_count: rows.length });
        this.modifyRequestedV16 = false;
        this.resetModifyV16();
        (this as any).createSpokenResponse(`La modificación ha sido aplicada por el backend. Comunica únicamente este resultado autorizado: ${JSON.stringify({ reservation_code: current.reservation_code, party_size: partySize, starts_at: startsAt, tables: rows.map((row) => row.table_name), allocation_mode: rows[0]?.allocation_mode })}. Después pregunta exactamente: ¿Necesitas algo más en lo que pueda ayudarte?`);
      } catch (error) {
        this.modifyConfirmationFingerprintV16 = null;
        (this as any).createSpokenResponse("La modificación no pudo aplicarse en la revalidación final. La reserva original sigue intacta. Indícalo y ofrece volver a comprobar otra opción.");
      }
      return;
    }

    this.modifyConfirmationFingerprintV16 = fingerprint;
    this.modifyConfirmV16 = false;
    (this as any).createSpokenResponse(`Resume la modificación propuesta usando únicamente estos datos: ${JSON.stringify({ reservation_code: current.reservation_code, party_size: partySize, starts_at: startsAt, customer_name: customerName, allocation_mode: plan[0].allocation_mode, tables: plan.map((row) => ({ table_name: row.table_name, capacity: row.max_capacity })) })}. Pregunta inequívocamente si confirma aplicar estos cambios. Aclara que la reserva original no se modifica hasta que confirme.`);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) { try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; } }
    if (event?.type === "response.function_call_arguments.done" && event.name === CONVERSATION_INTENT) this.captureStructuredTurnV16(event.arguments);
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
