export type ReservationDateScopePendingChange = {
  fromLocalDate: string;
  toLocalDate: string;
  requestedAtCallerTurnEpoch: number;
};

export type ReservationDateScopeDecision =
  | { action: "ALLOW_AND_SET"; localDate: string }
  | { action: "ALLOW"; localDate: string }
  | { action: "ALLOW_CONFIRMED_CHANGE"; localDate: string }
  | { action: "REQUIRE_CONFIRMATION"; fromLocalDate: string; toLocalDate: string };

export type ReservationDateScopeInput = {
  activeLocalDate: string | null;
  requestedLocalDate: string;
  pendingChange: ReservationDateScopePendingChange | null;
  currentCallerTurnEpoch: number;
};

/**
 * Deterministic continuity guard for an already-materialized reservation date.
 *
 * Natural-language date interpretation remains the agent's responsibility. This
 * policy only prevents a concrete local date from changing silently between
 * public reservation tool calls. A date transition is accepted only after the
 * exact transition was previously blocked and a later caller transcript has
 * opened a new semantic turn.
 */
export function decideReservationDateScope(input: ReservationDateScopeInput): ReservationDateScopeDecision {
  const { activeLocalDate, requestedLocalDate, pendingChange, currentCallerTurnEpoch } = input;

  if (!activeLocalDate) {
    return { action: "ALLOW_AND_SET", localDate: requestedLocalDate };
  }

  if (requestedLocalDate === activeLocalDate) {
    return { action: "ALLOW", localDate: requestedLocalDate };
  }

  const pendingMatches = Boolean(
    pendingChange &&
    pendingChange.fromLocalDate === activeLocalDate &&
    pendingChange.toLocalDate === requestedLocalDate,
  );
  const laterCallerTurn = Boolean(
    pendingChange &&
    Number.isInteger(currentCallerTurnEpoch) &&
    currentCallerTurnEpoch > pendingChange.requestedAtCallerTurnEpoch,
  );

  if (pendingMatches && laterCallerTurn) {
    return { action: "ALLOW_CONFIRMED_CHANGE", localDate: requestedLocalDate };
  }

  return {
    action: "REQUIRE_CONFIRMATION",
    fromLocalDate: activeLocalDate,
    toLocalDate: requestedLocalDate,
  };
}
