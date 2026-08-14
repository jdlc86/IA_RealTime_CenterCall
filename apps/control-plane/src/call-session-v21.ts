import { CallSession as CallSessionV20 } from "./call-session-v20";

const BaseConstructor = CallSessionV20 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV20.prototype as any;

type TablePlanRow = {
  allocation_mode?: string;
  table_id?: string;
  table_code?: string;
  table_name?: string;
  min_capacity?: number;
  max_capacity?: number;
  starts_at?: string;
  ends_at?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * v21 completes the direct agent-tool migration for multi-table reservations.
 * The authoritative multi-table plan is still produced by v16/backend logic;
 * v21 only exposes that existing plan as an explicit structured tool result so
 * Lucia can ask the customer whether separate tables are acceptable.
 */
export class CallSession extends BaseConstructor {
  private sendFunctionOutputV19(callId: string | undefined, output: Record<string, unknown>): void {
    if (output.status === "UNAVAILABLE") {
      const plan = (this as any).multitablePlanV16 as TablePlanRow[] | null | undefined;
      const draft = asRecord((this as any).reservationDraftV19);

      if (Array.isArray(plan) && plan.length > 1 && plan[0]?.allocation_mode === "MULTI_EXACT") {
        const capacities = plan.map((row) => Number(row.max_capacity ?? 0)).filter((value) => value > 0);
        const exactCapacity = capacities.reduce((sum, value) => sum + value, 0);
        const partySize = Number(draft.party_size ?? 0);
        const separateAccepted = draft.separate_tables_acceptable === true;
        const separateRejected = draft.separate_tables_acceptable === false;
        const mustBeClose = draft.tables_must_be_close === true;

        if (exactCapacity === partySize && partySize > 0) {
          if (mustBeClose || separateRejected) {
            (this as any).diagnostics?.checkpoint?.("DIRECT_RESERVATION_MULTITABLE_HUMAN_ASSISTANCE_V21", {
              party_size: partySize,
              capacities,
              tables_must_be_close: mustBeClose,
              separate_tables_acceptable: separateRejected ? false : null,
            });
            BasePrototype.sendFunctionOutputV19.call(this, callId, {
              ok: true,
              status: "HUMAN_ASSISTANCE_REQUIRED",
              reason: mustBeClose ? "TABLES_MUST_BE_CLOSE" : "SEPARATE_TABLES_REJECTED",
              party_size: partySize,
              allocation_mode: "MULTI_EXACT",
              table_capacities: capacities,
              exact_capacity: exactCapacity,
              message: "Existe una combinación exacta de varias mesas, pero el cliente requiere una configuración que el sistema no puede garantizar automáticamente. No se ha creado ninguna reserva.",
            });
            return;
          }

          if (!separateAccepted) {
            (this as any).diagnostics?.checkpoint?.("DIRECT_RESERVATION_MULTITABLE_OPTION_V21", {
              party_size: partySize,
              capacities,
              exact_capacity: exactCapacity,
            });
            BasePrototype.sendFunctionOutputV19.call(this, callId, {
              ok: true,
              status: "MULTITABLE_OPTION",
              party_size: partySize,
              allocation_mode: "MULTI_EXACT",
              table_capacities: capacities,
              exact_capacity: exactCapacity,
              requires_separation_confirmation: true,
              tables_are_guaranteed_close: false,
              instruction: "Explica al cliente la combinación exacta disponible y pregunta si acepta estar en mesas separadas. No confirmes reserva todavía. Si acepta, vuelve a llamar a restaurant_reservation_create con separate_tables_acceptable=true conservando los demás datos.",
            });
            return;
          }
        }
      }
    }

    BasePrototype.sendFunctionOutputV19.call(this, callId, output);
  }
}
