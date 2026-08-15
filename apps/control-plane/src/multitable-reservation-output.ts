type TablePlanRow = {
  allocation_mode?: string;
  max_capacity?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type MultitableOutputDecision = {
  handled: boolean;
  output?: Record<string, unknown>;
  diagnosticEvent?: string;
  diagnosticDetails?: Record<string, unknown>;
};

/**
 * Converts an authoritative exact multi-table plan into a public agent-tool
 * response. It never invents plans and never writes reservations.
 */
export function deriveMultitableOutput(
  output: Record<string, unknown>,
  planValue: unknown,
  draftValue: unknown,
): MultitableOutputDecision {
  if (output.status !== "UNAVAILABLE") return { handled: false };

  const plan = Array.isArray(planValue) ? planValue as TablePlanRow[] : null;
  const draft = asRecord(draftValue);
  if (!plan || plan.length <= 1 || plan[0]?.allocation_mode !== "MULTI_EXACT") return { handled: false };

  const capacities = plan.map((row) => Number(row.max_capacity ?? 0)).filter((value) => value > 0);
  const exactCapacity = capacities.reduce((sum, value) => sum + value, 0);
  const partySize = Number(draft.party_size ?? 0);
  const separateAccepted = draft.separate_tables_acceptable === true;
  const separateRejected = draft.separate_tables_acceptable === false;
  const mustBeClose = draft.tables_must_be_close === true;
  if (exactCapacity !== partySize || partySize <= 0) return { handled: false };

  if (mustBeClose || separateRejected) {
    return {
      handled: true,
      diagnosticEvent: "DIRECT_RESERVATION_MULTITABLE_HUMAN_ASSISTANCE_V21",
      diagnosticDetails: {
        party_size: partySize,
        capacities,
        tables_must_be_close: mustBeClose,
        separate_tables_acceptable: separateRejected ? false : null,
      },
      output: {
        ok: true,
        status: "HUMAN_ASSISTANCE_REQUIRED",
        reason: mustBeClose ? "TABLES_MUST_BE_CLOSE" : "SEPARATE_TABLES_REJECTED",
        party_size: partySize,
        allocation_mode: "MULTI_EXACT",
        table_capacities: capacities,
        exact_capacity: exactCapacity,
        message: "Existe una combinación exacta de varias mesas, pero el cliente requiere una configuración que el sistema no puede garantizar automáticamente. No se ha creado ninguna reserva.",
      },
    };
  }

  if (!separateAccepted) {
    return {
      handled: true,
      diagnosticEvent: "DIRECT_RESERVATION_MULTITABLE_OPTION_V21",
      diagnosticDetails: { party_size: partySize, capacities, exact_capacity: exactCapacity },
      output: {
        ok: true,
        status: "MULTITABLE_OPTION",
        party_size: partySize,
        allocation_mode: "MULTI_EXACT",
        table_capacities: capacities,
        exact_capacity: exactCapacity,
        requires_separation_confirmation: true,
        tables_are_guaranteed_close: false,
        instruction: "Explica al cliente la combinación exacta disponible y pregunta si acepta estar en mesas separadas. No confirmes reserva todavía. Si acepta, vuelve a llamar a restaurant_reservation_create con separate_tables_acceptable=true conservando los demás datos.",
      },
    };
  }

  return { handled: false };
}
