import { CallSession as CallSessionV29 } from "./call-session-v29";
import type { ToolGateway, ToolRequest, ToolResult } from "./tool-gateway";
import { SupabaseAdapter, type BusinessHours } from "./supabase-adapter";
import {
  businessWindowsForDate,
  endOfBusinessLocalDateExclusive,
  evaluateReservationBusinessHours,
  normalizeReservationLocalDateTime,
  sameBusinessLocalDate,
} from "./reservation-business-hours";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import { reservationSessionRuntimeFor } from "./reservation-session-runtime.js";
import { publicRestaurantToolAuthorizationPortFor } from "./semantic-tool-authorization-port.js";

const BaseConstructor = CallSessionV29 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV29.prototype as any;

const CHECK_AVAILABILITY = "check_reservation_availability";
const MANAGE_RESERVATION = "manage_reservation";
const CREATE_RESERVATION = "restaurant_reservation_create";
const SEARCH_RESERVATION = "restaurant_reservation_search";
const RESTAURANT_TIMEZONE = "Europe/Madrid";

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
 * v31 centralises reservation capacity and slot-search policy.
 *
 * Business hours are authoritative here: table availability is never consulted
 * for a closed day/out-of-hours request, and automatic alternative search never
 * silently crosses into another local calendar date.
 *
 * Shared reservation facts live in ReservationSessionRuntime. Public-tool
 * authority and realtime output are consumed only through version-neutral ports.
 * v31 owns only the transient table plan required to execute a multi-table commit.
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

  private async businessHoursV31(): Promise<BusinessHours[]> {
    const env = (this as any).env ?? {};
    const adapter = new SupabaseAdapter({
      SUPABASE_URL: requireString(env.SUPABASE_URL, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requireString(env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY"),
    });
    return adapter.listBusinessHours(requireString((this as any).tenantId, "tenant_id"));
  }

  private clearPlanV31(): void {
    this.planV31 = null;
    this.planKeyV31 = null;
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

  private async executeMultiTableReservationV31(request: ToolRequest, baseGateway: ToolGateway): Promise<ToolResult> {
    const plan = this.planV31;
    const draft = reservationSessionRuntimeFor(this).snapshot().draft;
    if (!plan?.length || plan.length < 2 || draft.separate_tables_acceptable !== true || draft.tables_must_be_close === true) {
      return baseGateway.execute(request) as Promise<ToolResult>;
    }

    const args = asObject(request.arguments);
    const partySize = integer(args.party_size);
    const rawStartsAt = text(args.starts_at);
    const customerName = text(args.customer_name);
    const customerPhone = text(args.customer_phone);
    const duration = integer(args.duration_minutes) ?? 90;
    const notes = text(args.notes);
    if (!partySize || !rawStartsAt || !customerName || !customerPhone) {
      return baseGateway.execute(request) as Promise<ToolResult>;
    }

    const startsAt = normalizeReservationLocalDateTime(rawStartsAt, RESTAURANT_TIMEZONE);
    const key = JSON.stringify({ party_size: partySize, starts_at: startsAt, duration_minutes: duration });
    if (key !== this.planKeyV31) return baseGateway.execute(request) as Promise<ToolResult>;

    if (args.confirm !== true) {
      return {
        ok: true,
        tool: MANAGE_RESERVATION,
        tenantId: request.context.tenantId,
        result: {
          stage: "CONFIRM_RESERVATION",
          party_size: partySize,
          starts_at: startsAt,
          customer_name: customerName,
          allocation_mode: "MULTI_EXACT",
          tables: plan.map((row) => ({ table_name: row.table_name, capacity: row.max_capacity })),
        },
      } as ToolResult;
    }

    try {
      const rows = await this.rpcV31<Record<string, unknown>>("create_restaurant_reservation_multi", {
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
      this.clearPlanV31();
      return {
        ok: true,
        tool: MANAGE_RESERVATION,
        tenantId: request.context.tenantId,
        result: {
          stage: "BOOKED",
          reservation_code: code,
          party_size: partySize,
          starts_at: startsAt,
          allocation_mode: "MULTI_EXACT",
          tables: rows.map((row) => ({ table_name: row.table_name, table_code: row.table_code })),
        },
      } as ToolResult;
    } catch (error) {
      return {
        ok: false,
        tool: MANAGE_RESERVATION,
        tenantId: request.context.tenantId,
        error: "EXECUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      } as ToolResult;
    }
  }

  private createToolGateway(): ToolGateway {
    const baseGateway = BasePrototype.createToolGateway.call(this) as ToolGateway;
    return {
      execute: async (request: ToolRequest): Promise<ToolResult> => {
        if (request.name === MANAGE_RESERVATION) {
          return this.executeMultiTableReservationV31(request, baseGateway);
        }
        if (request.name !== CHECK_AVAILABILITY) return baseGateway.execute(request) as Promise<ToolResult>;

        const args = asObject(request.arguments);
        const partySize = integer(args.party_size);
        const rawStartsAt = text(args.starts_at);
        const duration = integer(args.duration_minutes) ?? 90;
        if (!partySize || !rawStartsAt) return baseGateway.execute(request) as Promise<ToolResult>;
        const startsAt = normalizeReservationLocalDateTime(rawStartsAt, RESTAURANT_TIMEZONE);

        const businessHours = await this.businessHoursV31();
        const hoursDecision = evaluateReservationBusinessHours(startsAt, duration, businessHours, RESTAURANT_TIMEZONE);
        if (!hoursDecision.allowed) {
          this.clearPlanV31();
          (this as any).diagnostics?.checkpoint?.("RESERVATION_BUSINESS_HOURS_BLOCKED_V31", {
            operation: "check_availability",
            reason: hoursDecision.reason,
            local_date: hoursDecision.localDate,
            requested_local_time: hoursDecision.requestedLocalTime,
            duration_minutes: duration,
            weekday: hoursDecision.weekday,
            windows: hoursDecision.windows,
          });
          return {
            ok: true,
            tool: CHECK_AVAILABILITY,
            tenantId: request.context.tenantId,
            result: {
              requested_available: false,
              business_hours_blocked: true,
              business_hours_authoritative: true,
              business_hours_reason: hoursDecision.reason,
              requested_local_date: hoursDecision.localDate,
              requested_local_time: hoursDecision.requestedLocalTime,
              business_hours: hoursDecision.windows,
            },
          } as ToolResult;
        }

        const plan = await this.tablePlanV31(partySize, startsAt, duration);
        const key = JSON.stringify({ party_size: partySize, starts_at: startsAt, duration_minutes: duration });
        this.planV31 = plan.length ? plan : null;
        this.planKeyV31 = plan.length ? key : null;

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
        const draft = reservationSessionRuntimeFor(this).snapshot().draft;
        const separateAccepted = draft.separate_tables_acceptable === true;
        const mustBeClose = draft.tables_must_be_close === true;
        const canAutoProceed = !multi || (separateAccepted && !mustBeClose);

        (this as any).diagnostics?.checkpoint?.("RESERVATION_CAPACITY_PLAN_V31", {
          party_size: partySize,
          allocation_mode: plan[0]?.allocation_mode,
          table_count: plan.length,
          total_capacity: totalCapacity,
          unused_seats: unusedSeats,
          policy_max_unused_seats: 1,
          reservation_state_owner: "reservation_session_runtime",
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

  private emitCreateOutputV31(callId: string | undefined, output: Record<string, unknown>): void {
    const port = realtimeCommandPortFor(this as any);
    port.submitToolResult({ callId, toolName: CREATE_RESERVATION, output });
    port.createDefaultResponse();
  }

  private sendFunctionOutputV19(callId: string | undefined, output: Record<string, unknown>): void {
    if (output.status === "UNAVAILABLE") {
      const result = output as Record<string, unknown>;
      if (result.business_hours_blocked === true) {
        const closedDay = result.business_hours_reason === "CLOSED_DAY";
        this.emitCreateOutputV31(callId, {
          ok: true,
          status: closedDay ? "RESTAURANT_CLOSED" : "OUTSIDE_BUSINESS_HOURS",
          business_hours_authoritative: true,
          requested_local_date: result.requested_local_date,
          requested_local_time: result.requested_local_time,
          business_hours: result.business_hours,
          instruction: closedDay
            ? "El restaurante está cerrado en la fecha solicitada. No busques ni propongas otro día automáticamente. Informa del cierre y pregunta al cliente si quiere elegir otra fecha."
            : "La reserva solicitada no cabe completamente dentro del horario comercial de ese día. No busques ni propongas otro día automáticamente. Indica el horario disponible y pregunta por otra hora o fecha.",
        });
        return;
      }

      if (result.human_assistance_required === true || result.structural_fit_available === false) {
        this.emitCreateOutputV31(callId, {
          ok: true,
          status: "HUMAN_ASSISTANCE_REQUIRED",
          reason: "CAPACITY_POLICY_REQUIRES_HUMAN",
          capacity_policy: "MAX_ONE_UNUSED_SEAT",
          instruction: "Explica que la asignación automática de mesas no puede acomodar al grupo respetando como máximo un asiento libre. No rechaces ni canceles nada. Indica que esta configuración necesita una persona del restaurante y usa restaurant_human_assistance si el cliente quiere continuar por esa vía.",
        });
        return;
      }

      const plan = this.planV31;
      const draft = reservationSessionRuntimeFor(this).snapshot().draft;
      if (Array.isArray(plan) && plan.length > 1) {
        const capacities = plan.map((row) => row.max_capacity);
        const partySize = integer(draft.party_size) ?? 0;
        const totalCapacity = capacities.reduce((sum, value) => sum + value, 0);
        const unusedSeats = totalCapacity - partySize;
        const rejected = draft.separate_tables_acceptable === false;
        const mustBeClose = draft.tables_must_be_close === true;
        if (rejected || mustBeClose) {
          this.emitCreateOutputV31(callId, {
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
          this.emitCreateOutputV31(callId, {
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
        this.emitCreateOutputV31(callId, {
          ...output,
          status: "UNAVAILABLE_WITH_SEARCH_OPTION",
          instruction: "La hora concreta no está disponible, pero la configuración de mesas sí admite este grupo. Ofrece buscar turnos alternativos únicamente dentro de la misma fecha solicitada con restaurant_reservation_search. Para cambiar de día, espera a que el cliente elija explícitamente otra fecha.",
        });
        return;
      }
    }
    this.emitCreateOutputV31(callId, output);
  }

  private sendOutputV31(callId: string | undefined, output: Record<string, unknown>): void {
    const port = realtimeCommandPortFor(this as any);
    port.submitToolResult({ callId, toolName: SEARCH_RESERVATION, output });
    port.createDefaultResponse();
  }

  private async executeSearchV31(callId: string | undefined, args: Record<string, unknown>): Promise<void> {
    const partySize = integer(args.party_size);
    if (!partySize || partySize < 1 || partySize > 100) throw new Error("party_size is required");
    const duration = integer(args.duration_minutes) ?? 90;
    const step = integer(args.step_minutes) ?? 30;
    const maxResults = Math.min(10, Math.max(1, integer(args.max_results) ?? 5));
    const preferredRaw = text(args.preferred_starts_at);
    const fromRaw = text(args.from) ?? preferredRaw;
    if (!fromRaw) throw new Error("from or preferred_starts_at is required");
    const from = normalizeReservationLocalDateTime(fromRaw, RESTAURANT_TIMEZONE);
    const preferred = preferredRaw ? normalizeReservationLocalDateTime(preferredRaw, RESTAURANT_TIMEZONE) : undefined;
    const requestedToRaw = text(args.to);
    const requestedTo = requestedToRaw ? normalizeReservationLocalDateTime(requestedToRaw, RESTAURANT_TIMEZONE) : undefined;

    const businessHours = await this.businessHoursV31();
    const dateScope = businessWindowsForDate(from, businessHours, RESTAURANT_TIMEZONE);
    if (!dateScope.windows.length) {
      (this as any).diagnostics?.checkpoint?.("RESERVATION_BUSINESS_HOURS_BLOCKED_V31", {
        operation: "search",
        reason: "CLOSED_DAY",
        local_date: dateScope.localDate,
        weekday: dateScope.weekday,
      });
      this.sendOutputV31(callId, {
        ok: true,
        status: "RESTAURANT_CLOSED",
        business_hours_authoritative: true,
        requested_local_date: dateScope.localDate,
        business_hours: [],
        instruction: "El restaurante está cerrado en la fecha solicitada. No amplíes la búsqueda a otro día. Pregunta al cliente si quiere elegir otra fecha.",
      });
      return;
    }

    if (preferred) {
      const preferredDecision = evaluateReservationBusinessHours(preferred, duration, businessHours, RESTAURANT_TIMEZONE);
      if (!preferredDecision.allowed) {
        (this as any).diagnostics?.checkpoint?.("RESERVATION_BUSINESS_HOURS_BLOCKED_V31", {
          operation: "search",
          reason: preferredDecision.reason,
          local_date: preferredDecision.localDate,
          requested_local_time: preferredDecision.requestedLocalTime,
          duration_minutes: duration,
        });
        this.sendOutputV31(callId, {
          ok: true,
          status: preferredDecision.reason === "CLOSED_DAY" ? "RESTAURANT_CLOSED" : "OUTSIDE_BUSINESS_HOURS",
          business_hours_authoritative: true,
          requested_local_date: preferredDecision.localDate,
          requested_local_time: preferredDecision.requestedLocalTime,
          business_hours: preferredDecision.windows,
          instruction: preferredDecision.reason === "CLOSED_DAY"
            ? "El restaurante está cerrado en la fecha solicitada. No busques otro día automáticamente; pide al cliente otra fecha."
            : "La hora solicitada no cabe completamente dentro del horario comercial. No cambies de día automáticamente; ofrece elegir otra hora dentro de ese día o una nueva fecha.",
        });
        return;
      }
    }

    if (requestedTo && !sameBusinessLocalDate(from, requestedTo, RESTAURANT_TIMEZONE)) {
      (this as any).diagnostics?.checkpoint?.("RESERVATION_SEARCH_CROSS_DATE_BLOCKED_V31", {
        reason: "CALLER_DATE_SCOPE_REQUIRED",
        requested_local_date: dateScope.localDate,
      });
      this.sendOutputV31(callId, {
        ok: true,
        status: "DATE_SCOPE_REQUIRES_CALLER_CHOICE",
        requested_local_date: dateScope.localDate,
        business_hours: dateScope.windows,
        instruction: "La búsqueda automática no puede cambiar de fecha por iniciativa propia. Presenta el resultado de la fecha solicitada o pregunta qué otra fecha quiere el cliente.",
      });
      return;
    }

    const to = requestedTo ?? endOfBusinessLocalDateExclusive(from, RESTAURANT_TIMEZONE);
    const rows = await this.rpcV31<SearchSlot>("search_restaurant_table_slots", {
      p_tenant_id: requireString((this as any).tenantId, "tenant_id"),
      p_party_size: partySize,
      p_from: from,
      p_to: to,
      p_duration_minutes: duration,
      p_step_minutes: step,
      p_local_time_from: text(args.time_from) ?? null,
      p_local_time_to: text(args.time_to) ?? null,
      p_timezone: RESTAURANT_TIMEZONE,
      p_limit: maxResults,
    });
    const sameDateRows = rows.filter((row) => sameBusinessLocalDate(row.starts_at, from, RESTAURANT_TIMEZONE));

    (this as any).diagnostics?.checkpoint?.("RESERVATION_SLOT_SEARCH_COMPLETED_V31", {
      party_size: partySize,
      result_count: sameDateRows.length,
      step_minutes: step,
      max_unused_seats: 1,
      requested_local_date: dateScope.localDate,
      same_date_scope_enforced: true,
      cross_date_rows_discarded: rows.length - sameDateRows.length,
    });

    this.sendOutputV31(callId, {
      ok: true,
      status: sameDateRows.length ? "SUGGESTIONS_AVAILABLE" : "NO_AUTOMATIC_SUGGESTIONS",
      party_size: partySize,
      requested_local_date: dateScope.localDate,
      options: sameDateRows,
      capacity_policy: "MAX_ONE_UNUSED_SEAT",
      business_hours_authoritative: true,
      date_scope: "SAME_LOCAL_DATE",
      instruction: sameDateRows.length
        ? "Presenta como máximo tres opciones de esta misma fecha y pregunta cuál prefiere. No reserves hasta que el cliente elija una y pase por restaurant_reservation_create. No cambies de día sin un nuevo criterio explícito del cliente."
        : "No se encontraron turnos automáticos en la fecha solicitada. No busques otro día ni escales automáticamente; pregunta al cliente si quiere elegir otra fecha o ampliar criterios.",
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = adaptRealtimeProviderEvents(data).find(
      (candidate) => candidate.type === "SEMANTIC_TOOL_SELECTED" && candidate.name === SEARCH_RESERVATION,
    );

    if (event?.type === "SEMANTIC_TOOL_SELECTED" && event.name === SEARCH_RESERVATION) {
      const authorized = publicRestaurantToolAuthorizationPortFor(this).authorize({
        name: event.name,
        call_id: event.callId,
        arguments: event.arguments,
      });
      if (!authorized) return;

      let args: Record<string, unknown>;
      try { args = parseObject(event.arguments); }
      catch (error) {
        this.sendOutputV31(event.callId, { ok: false, status: "ERROR", error: "INVALID_ARGUMENTS", message: error instanceof Error ? error.message : String(error) });
        return;
      }
      (this as any).diagnostics?.checkpoint?.("LUCIA_AGENT_TOOL_SELECTED", {
        tool: SEARCH_RESERVATION,
        compatibility_executor: "direct_reservation_search_v31",
        semantic_authority: "semantic_tool_authorization_port",
      });
      try { await this.executeSearchV31(event.callId, args); }
      catch (error) {
        this.sendOutputV31(event.callId, { ok: false, status: "ERROR", error: "SEARCH_FAILED", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
