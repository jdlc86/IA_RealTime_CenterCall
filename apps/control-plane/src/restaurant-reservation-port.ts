import {
  SupabaseAdapter,
  type BookedReservationSummary,
  type RestaurantAvailability,
} from "./supabase-adapter.js";

export type { BookedReservationSummary, RestaurantAvailability } from "./supabase-adapter.js";

export type RestaurantTablePlanRow = {
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

export type RestaurantTablePlanRequest = Readonly<{
  tenantId: string;
  startsAt: string;
  partySize: number;
  durationMinutes: number;
  excludeReservationId?: string | null;
}>;

export type RestaurantAvailabilityRequest = Readonly<{
  tenantId: string;
  startsAt: string;
  partySize: number;
  durationMinutes: number;
}>;

export type MultiTableReservationRequest = Readonly<{
  tenantId: string;
  customerName: string;
  customerPhone: string;
  partySize: number;
  startsAt: string;
  durationMinutes: number;
  notes?: string | null;
  source?: "voice" | "web" | "manual" | "api";
}>;

export type ModifyRestaurantReservationRequest = Readonly<{
  tenantId: string;
  reservationId: string;
  callerPhone: string;
  partySize: number;
  startsAt: string;
  durationMinutes: number;
  customerName: string;
  notes?: string | null;
}>;

export type RestaurantCapacityFit = Readonly<{
  allocation_mode: string;
  table_count: number;
  total_capacity: number;
  unused_seats: number;
}>;

export type RestaurantCapacityFitRequest = Readonly<{
  tenantId: string;
  partySize: number;
}>;

export type RestaurantSearchSlot = Readonly<{
  starts_at: string;
  allocation_mode: string;
  table_count: number;
  total_capacity: number;
  unused_seats: number;
}>;

export type RestaurantSlotSearchRequest = Readonly<{
  tenantId: string;
  partySize: number;
  from: string;
  to: string;
  durationMinutes: number;
  stepMinutes: number;
  localTimeFrom?: string | null;
  localTimeTo?: string | null;
  timezone: string;
  limit: number;
}>;

type RestaurantReservationHost = object & {
  env?: Record<string, unknown>;
};

type ReservationDataAdapter = Pick<SupabaseAdapter, "checkRestaurantAvailability" | "listBookedReservationsByPhone" | "cancelBookedReservation"> & {
  invokeRpc<T>(name: string, body: Record<string, unknown>): Promise<T[]>;
};

function requiredConfig(host: RestaurantReservationHost, name: "SUPABASE_URL" | "SUPABASE_SECRET_KEY"): string {
  const value = host.env?.[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

/**
 * Capability boundary for restaurant reservation persistence.
 * Session generations speak reservation operations; the provider adapter owns REST/RPC wire details.
 */
export class RestaurantReservationRuntime {
  private readonly adapter: ReservationDataAdapter;

  constructor(host: RestaurantReservationHost, adapter?: ReservationDataAdapter) {
    this.adapter = adapter ?? new SupabaseAdapter({
      SUPABASE_URL: requiredConfig(host, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requiredConfig(host, "SUPABASE_SECRET_KEY"),
    });
  }

  listBookedReservationsByPhone(tenantId: string, callerPhone: string): Promise<BookedReservationSummary[]> {
    return this.adapter.listBookedReservationsByPhone(tenantId, callerPhone);
  }

  cancelBookedReservation(tenantId: string, reservationId: string, callerPhone: string): Promise<BookedReservationSummary | null> {
    return this.adapter.cancelBookedReservation(tenantId, reservationId, callerPhone);
  }

  checkAvailability(request: RestaurantAvailabilityRequest): Promise<RestaurantAvailability[]> {
    return this.adapter.checkRestaurantAvailability(
      request.tenantId,
      request.startsAt,
      request.partySize,
      request.durationMinutes,
    );
  }

  checkTablePlan(request: RestaurantTablePlanRequest): Promise<RestaurantTablePlanRow[]> {
    return this.adapter.invokeRpc<RestaurantTablePlanRow>("check_restaurant_table_plan", {
      p_tenant_id: request.tenantId,
      p_starts_at: request.startsAt,
      p_party_size: request.partySize,
      p_duration_minutes: request.durationMinutes,
      p_exclude_reservation_id: request.excludeReservationId ?? null,
    });
  }

  createMultiTableReservation(request: MultiTableReservationRequest): Promise<Record<string, unknown>[]> {
    return this.adapter.invokeRpc<Record<string, unknown>>("create_restaurant_reservation_multi", {
      p_tenant_id: request.tenantId,
      p_customer_name: request.customerName,
      p_customer_phone: request.customerPhone,
      p_party_size: request.partySize,
      p_starts_at: request.startsAt,
      p_duration_minutes: request.durationMinutes,
      p_notes: request.notes ?? null,
      p_source: request.source ?? "voice",
    });
  }

  modifyReservation(request: ModifyRestaurantReservationRequest): Promise<Record<string, unknown>[]> {
    return this.adapter.invokeRpc<Record<string, unknown>>("modify_restaurant_reservation", {
      p_tenant_id: request.tenantId,
      p_reservation_id: request.reservationId,
      p_caller_phone: request.callerPhone,
      p_party_size: request.partySize,
      p_starts_at: request.startsAt,
      p_duration_minutes: request.durationMinutes,
      p_customer_name: request.customerName,
      p_notes: request.notes ?? null,
    });
  }

  checkCapacityFit(request: RestaurantCapacityFitRequest): Promise<RestaurantCapacityFit[]> {
    return this.adapter.invokeRpc<RestaurantCapacityFit>("check_restaurant_capacity_fit", {
      p_tenant_id: request.tenantId,
      p_party_size: request.partySize,
    });
  }

  searchTableSlots(request: RestaurantSlotSearchRequest): Promise<RestaurantSearchSlot[]> {
    return this.adapter.invokeRpc<RestaurantSearchSlot>("search_restaurant_table_slots", {
      p_tenant_id: request.tenantId,
      p_party_size: request.partySize,
      p_from: request.from,
      p_to: request.to,
      p_duration_minutes: request.durationMinutes,
      p_step_minutes: request.stepMinutes,
      p_local_time_from: request.localTimeFrom ?? null,
      p_local_time_to: request.localTimeTo ?? null,
      p_timezone: request.timezone,
      p_limit: request.limit,
    });
  }
}

const runtimes = new WeakMap<object, RestaurantReservationRuntime>();

export function restaurantReservationPortFor(host: RestaurantReservationHost): RestaurantReservationRuntime {
  let runtime = runtimes.get(host);
  if (!runtime) {
    runtime = new RestaurantReservationRuntime(host);
    runtimes.set(host, runtime);
  }
  return runtime;
}
