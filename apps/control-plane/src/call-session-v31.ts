import { CallSession as CallSessionV29 } from "./call-session-v29";
import type { ToolGateway, ToolRequest, ToolResult } from "./tool-gateway";

const BaseConstructor = CallSessionV29 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV29.prototype as any;

const CHECK_AVAILABILITY = "check_reservation_availability";
const MANAGE_RESERVATION = "manage_reservation";
const SEARCH_RESERVATION = "restaurant_reservation_search";

type RealtimeEvent = { type?: string; name?: string; call_id?: string; arguments?: string };
type TablePlanRow = {
  allocation_mode: string;
  plan_order: number;
  table_id: string;
  table_code: string;
  table_name: string;
  min_capacity: number;
  max_capacity: number;
  starts_at: string;
  ends_at: string;
};
type SearchSlot = {
  starts_at: string;
  allocation_mode: string;
  table_count: number;
  total_capacity: number;
  unused_seats: number;
};
type CapacityFit = {
  allocation_mode: string;
  table_count: number;
  total_capacity: number;
  unused_seats: number;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function parseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("arguments must be an object");
  return parsed as Record<string, unknown>;
}
function integer(value: unknown): number | undefined { return Number.isInteger(value) ? value as number : undefined; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`);
  return value.trim();
}

/**
 * v31 centralises two reservation usability policies:
 * - automatic seating may waste at most one seat in total;
 * - Lucia can search nearby slots by simple date/time criteria without creating a reservation.
 *
 * SQL remains authoritative for table allocation and slot availability. If the
 * restaurant's table topology cannot satisfy the <=1 unused-seat rule, the
 * result escalates to human assistance instead of rejecting/cancelling anything.
 */
export class CallSession extends BaseConstructor {
  private planV31: TablePlanRow[] | null = null;
  private planKeyV31: string | null = null;

  private async rpcV31<T>(name: string, body: Record<string, unknown>): Promise<T[]> {
    const baseUrl = requireString((this as any).env?.SUPABASE_URL, "SUPABASE_URL").replace(/\/+$/, "");
    const key = requireString((this as any).env?.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY");
    const response = await fetch(`${baseUrl}/rest/v1/rpc/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${name} failed with HTTP ${response.status}: ${raw.slice(0, 250)}`);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${name} returned invalid payload`);
    return parsed as T[];
  }

  private async tablePlanV31(partySize: number, startsAt: string, duration: number): Promise<TablePlanRow[]> {
    return this.rpcV31<TablePlanRow>("check_restaurant_table_plan", {
      p_tenant_id: requireString((this as any).tenantId, "tenant_id"),
      p_starts_at: startsAt,
      p_party_size: partySize,
      p_duration_minutes: duration,
      p_exclude_reservation_id: null,
    });
  }

  private createToolGateway(): ToolGateway {
    const baseGateway = BasePrototype.createToolGateway.call(this) as ToolGateway;
    return {
      execute: async (request: ToolRequest): Promise<ToolResult> => {
        if (request.name !== CHECK_AVAILABILITY) return baseGateway.execute(request) as Promise<ToolResult>;

        const args = asObject(request.arguments);
        const partySize = integer(args.party_size);
        const startsAt = text(args.starts_at);
        const duration = integer(args.duration_minutes) ?? 90;
        if (!partySize || !startsAt) return baseGateway.execute(request) as Promise<ToolResult>;

        const plan = await this.tablePlanV31(partySize, startsAt, duration);
        const key = JSON.stringify({ party_size: partySize, starts_at: startsAt, duration_minutes: duration });
        this.planV31 = plan.length ? plan : null;
        this.planKeyV31 = plan.length ? key : null;

        // Keep the older multi-table booking executor synchronized so it can
        // perform the final atomic write after the customer accepts separation.
        (this as any).multitablePlanV16 = plan.length > 1 ? plan : null;
        (this as any).multitableKeyV16 = plan.length > 1 ? key : null;

        if (!plan.length) {
          const fit = await this.rpcV31<CapacityFit>("check_restaurant_capacity_fit", {
            p_tenant_id: request.context.tenantId,
            p_party_size: partySize,
          });
          const structuralFit = fit[0] ?? null;
          return {
            ok: true,
            tool: CHECK_AVAILABILITY,
            tenantId: request.context.tenantId,
            result: {
              requested_available: false,
              capacity_policy: "MAX_ONE_UNUSED_SEAT",
              structural_fit_available: structuralFit !== null,
              ...(structuralFit ? {
                structural_allocation_mode: structuralFit.allocation_mode,
                structural_total_capacity: structuralFit.total_capacity,
                structural_unused_seats: structuralFit.unused_seats,
                suggestion: "SEARCH_ALTERNATIVE_SLOTS",
              } : {
                human_assistance_required: true,
                reason: "CAPACITY_POLICY_REQUIRES_HUMAN",
              }),
            },
          } as ToolResult;
        }

        const totalCapacity = plan.reduce((sum, row) => sum + row.max_capacity, 0);
        const unusedSeats = totalCapacity - partySize;
        const multi = plan.length > 1;
        const separateAccepted = (this as any).separateTablesAcceptableV16 === true;
        const mustBeClose = (this as any).tablesMustBeCloseV16 === true;
        const canAutoProceed = !multi || (separateAccepted && !mustBeClose);

        (this as any).diagnostics?.checkpoint?.("RESERVATION_CAPACITY_PLAN_V31", {
          party_size: partySize,
          allocation_mode: plan[0]?.allocation_mode,
          table_count: plan.length,
          total_capacity: totalCapacity,
          unused_seats: unusedSeats,
          policy_max_unused_seats: 1,
        });

        return {
          ok: true,
          tool: CHECK_AVAILABILITY,
          tenantId: request.context.tenantId,
          result: {
            requested_available: canAutoProceed,
            allocation_mode: plan[0]?.allocation_mode,
            table_count: plan.length,
            total_capacity: totalCapacity,
            unused_seats: unusedSeats,
            capacity_policy: "MAX_ONE_UNUSED_SEAT",
            requested_candidates: plan.map((row) => ({
              starts_at: row.starts_at,
              table_code: row.table_code,
              table_name: row.table_name,
              max_capacity: row.max_capacity,
            })),
          },
        } as ToolResult;
      },
    } as ToolGateway;
  }

  private sendFunctionOutputV19(callId: string | undefined, output: Record<string, unknown>): void {
    if (output.status === "UNAVAILABLE") {
      const result = output as Record<string, unknown>;
      if (result.human_assistance_required === true || result.structural_fit_available === false) {
        BasePrototype.sendFunctionOutputV19.call(this, callId, {
          ok: true,
          status: "HUMAN_ASSISTANCE_REQUIRED",
          reason: "CAPACITY_POLICY_REQUIRES_HUMAN",
          capacity_policy: "MAX_ONE_UNUSED_SEAT",
          instruction: "Explica que la asignación automática de mesas no puede acomodar al grupo respetando como máximo un asiento libre. No rechaces ni canceles nada. Indica que esta configuración necesita una persona del restaurante y usa restaurant_human_assistance si el cliente quiere continuar por esa vía.",
        });
        return;
      }

      const plan = this.planV31;
      const draft = asObject((this as any).reservationDraftV19);
      if (Array.isArray(plan) && plan.length > 1) {
        const capacities = plan.map((row) => row.max_capacity);
        const partySize = Number(draft.party_size ?? 0);
        const totalCapacity = capacities.reduce((sum, value) => sum + value, 0);
        const unusedSeats = totalCapacity - partySize;
        const rejected = draft.separate_tables_acceptable === false;
        const mustBeClose = draft.tables_must_be_close === true;
        if (rejected || mustBeClose) {
          BasePrototype.sendFunctionOutputV19.call(this, callId, {
            ok: true,
            status: "HUMAN_ASSISTANCE_REQUIRED",
            reason: mustBeClose ? "TABLES_MUST_BE_CLOSE" : "SEPARATE_TABLES_REJECTED",
            table_capacities: capacities,
            total_capacity: totalCapacity,
            unused_seats: unusedSeats,
            instruction: "No rechaces ni canceles la reserva. Explica que esta configuración necesita gestión humana.",
          });
          return;
        }
        if (draft.separate_tables_acceptable !== true) {
          BasePrototype.sendFunctionOutputV19.call(this, callId, {
            ok: true,
            status: "MULTITABLE_OPTION",
            allocation_mode: plan[0]?.allocation_mode,
            party_size: partySize,
            table_capacities: capacities,
            total_capacity: totalCapacity,
            unused_seats: unusedSeats,
            requires_separation_confirmation: true,
            instruction: "Explica la combinación disponible y pregunta si acepta mesas separadas. La capacidad total puede superar al grupo en un solo asiento. No confirmes todavía.",
          });
          return;
        }
      }

      if (result.suggestion === "SEARCH_ALTERNATIVE_SLOTS") {
        BasePrototype.sendFunctionOutputV19.call(this, callId, {
          ...output,
          status: "UNAVAILABLE_WITH_SEARCH_OPTION",
          instruction: "La hora concreta no está disponible, pero la configuración de mesas sí admite este grupo. Ofrece buscar los turnos más cercanos con restaurant_reservation_search.",
        });
        return;
      }
    }
    BasePrototype.sendFunctionOutputV19.call(this, callId, output);
  }

  private sendOutputV31(callId: string | undefined, output: Record<string, unknown>): void {
    (this as any).send?.({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    (this as any).send?.({ type: "response.create" });
  }

  private async executeSearchV31(callId: string | undefined, args: Record<string, unknown>): Promise<void> {
    const partySize = integer(args.party_size);
    if (!partySize || partySize < 1 || partySize > 100) throw new Error("party_size is required");
    const duration = integer(args.duration_minutes) ?? 90;
    const step = integer(args.step_minutes) ?? 30;
    const maxResults = Math.min(10, Math.max(1, integer(args.max_results) ?? 5));
    const preferred = text(args.preferred_starts_at);
    const from = text(args.from) ?? preferred;
    if (!from) throw new Error("from or preferred_starts_at is required");
    const fromMs = Date.parse(from);
    if (!Number.isFinite(fromMs)) throw new Error("invalid search start");
    const to = text(args.to) ?? new Date(fromMs + 7 * 24 * 60 * 60 * 1000).toISOString();

    const rows = await this.rpcV31<SearchSlot>("search_restaurant_table_slots", {
      p_tenant_id: requireString((this as any).tenantId, "tenant_id"),
      p_party_size: partySize,
      p_from: from,
      p_to: to,
      p_duration_minutes: duration,
      p_step_minutes: step,
      p_local_time_from: text(args.time_from) ?? null,
      p_local_time_to: text(args.time_to) ?? null,
      p_timezone: "Europe/Madrid",
      p_limit: maxResults,
    });

    (this as any).diagnostics?.checkpoint?.("RESERVATION_SLOT_SEARCH_COMPLETED_V31", {
      party_size: partySize,
      result_count: rows.length,
      step_minutes: step,
      max_unused_seats: 1,
    });

    this.sendOutputV31(callId, {
      ok: true,
      status: rows.length ? "SUGGESTIONS_AVAILABLE" : "NO_AUTOMATIC_SUGGESTIONS",
      party_size: partySize,
      options: rows,
      capacity_policy: "MAX_ONE_UNUSED_SEAT",
      instruction: rows.length
        ? "Presenta como máximo tres opciones de forma breve y pregunta cuál prefiere. No reserves hasta que el cliente elija una y pase por restaurant_reservation_create."
        : "No se encontraron turnos automáticos en el rango. No rechaces ni canceles nada; ofrece ampliar criterios o asistencia humana.",
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const textData = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (textData) { try { event = JSON.parse(textData) as RealtimeEvent; } catch { event = null; } }

    if (event?.type === "response.function_call_arguments.done" && event.name === SEARCH_RESERVATION) {
      let args: Record<string, unknown>;
      try { args = parseObject(event.arguments); }
      catch (error) {
        this.sendOutputV31(event.call_id, { ok: false, status: "ERROR", error: "INVALID_ARGUMENTS", message: error instanceof Error ? error.message : String(error) });
        return;
      }
      (this as any).diagnostics?.checkpoint?.("LUCIA_AGENT_TOOL_SELECTED", { tool: SEARCH_RESERVATION, compatibility_executor: "direct_reservation_search_v31" });
      try { await this.executeSearchV31(event.call_id, args); }
      catch (error) {
        this.sendOutputV31(event.call_id, { ok: false, status: "ERROR", error: "SEARCH_FAILED", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
