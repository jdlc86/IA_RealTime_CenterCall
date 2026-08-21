import type { RestaurantTablePlanRow } from "./restaurant-reservation-port.js";

export type ReservationMultitablePreferences = Readonly<{
  separateTablesAcceptable?: boolean;
  tablesMustBeClose?: boolean;
}>;

export type ReservationMultitableSnapshot = Readonly<{
  separateTablesAcceptable?: boolean;
  tablesMustBeClose: boolean;
  plan: RestaurantTablePlanRow[] | null;
  planKey: string | null;
}>;

function clonePlan(plan: RestaurantTablePlanRow[] | null): RestaurantTablePlanRow[] | null {
  return plan?.map((row) => ({ ...row })) ?? null;
}

/**
 * Single session-scoped owner for multi-table preferences and the backend plan
 * they authorize. Consumers receive defensive snapshots instead of inherited
 * access to historical CallSession fields.
 */
export class ReservationMultitableRuntime {
  private separateTablesAcceptable: boolean | undefined;
  private tablesMustBeClose = false;
  private plan: RestaurantTablePlanRow[] | null = null;
  private planKey: string | null = null;

  snapshot(): ReservationMultitableSnapshot {
    return Object.freeze({
      separateTablesAcceptable: this.separateTablesAcceptable,
      tablesMustBeClose: this.tablesMustBeClose,
      plan: clonePlan(this.plan),
      planKey: this.planKey,
    });
  }

  capturePreferences(preferences: ReservationMultitablePreferences): void {
    if (preferences.separateTablesAcceptable !== undefined) {
      this.separateTablesAcceptable = preferences.separateTablesAcceptable;
    }
    if (preferences.tablesMustBeClose !== undefined) {
      this.tablesMustBeClose = preferences.tablesMustBeClose;
    }
  }

  recordPlan(plan: RestaurantTablePlanRow[], planKey: string): void {
    this.plan = clonePlan(plan);
    this.planKey = planKey;
  }

  clearPlan(): void {
    this.plan = null;
    this.planKey = null;
  }
}

const runtimes = new WeakMap<object, ReservationMultitableRuntime>();

export function reservationMultitableRuntimeFor(session: object): ReservationMultitableRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new ReservationMultitableRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}
