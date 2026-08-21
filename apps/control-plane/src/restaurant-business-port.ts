import {
  SupabaseAdapter,
  type BusinessHours,
  type BusinessProfessional,
  type BusinessService,
  type RestaurantMenuItem,
} from "./supabase-adapter.js";

export type { BusinessHours, BusinessProfessional, BusinessService, RestaurantMenuItem } from "./supabase-adapter.js";

type RestaurantBusinessHost = object & {
  env?: Record<string, unknown>;
};

type RestaurantBusinessDataAdapter = Pick<
  SupabaseAdapter,
  "listServices" | "listProfessionals" | "listBusinessHours" | "listMenuItems"
>;

function requiredConfig(host: RestaurantBusinessHost, name: "SUPABASE_URL" | "SUPABASE_SECRET_KEY"): string {
  const value = host.env?.[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

/** Provider-neutral read boundary for restaurant catalogue and operating facts. */
export class RestaurantBusinessRuntime {
  private readonly adapter: RestaurantBusinessDataAdapter;

  constructor(host: RestaurantBusinessHost, adapter?: RestaurantBusinessDataAdapter) {
    this.adapter = adapter ?? new SupabaseAdapter({
      SUPABASE_URL: requiredConfig(host, "SUPABASE_URL"),
      SUPABASE_SECRET_KEY: requiredConfig(host, "SUPABASE_SECRET_KEY"),
    });
  }

  listServices(tenantId: string): Promise<BusinessService[]> {
    return this.adapter.listServices(tenantId);
  }

  listProfessionals(tenantId: string): Promise<BusinessProfessional[]> {
    return this.adapter.listProfessionals(tenantId);
  }

  listBusinessHours(tenantId: string): Promise<BusinessHours[]> {
    return this.adapter.listBusinessHours(tenantId);
  }

  listMenuItems(tenantId: string): Promise<RestaurantMenuItem[]> {
    return this.adapter.listMenuItems(tenantId);
  }
}

const runtimes = new WeakMap<object, RestaurantBusinessRuntime>();

export function restaurantBusinessPortFor(host: RestaurantBusinessHost): RestaurantBusinessRuntime {
  let runtime = runtimes.get(host);
  if (!runtime) {
    runtime = new RestaurantBusinessRuntime(host);
    runtimes.set(host, runtime);
  }
  return runtime;
}
