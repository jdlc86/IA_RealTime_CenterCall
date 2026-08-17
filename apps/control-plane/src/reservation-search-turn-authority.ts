export type ReservationSearchAuthorityState = {
  currentTurnId: string | null;
  consumedTurnId: string | null;
  recoveryIssuedTurnId: string | null;
};

export type ReservationSearchDecision =
  | { kind: "ALLOW"; state: ReservationSearchAuthorityState }
  | { kind: "BLOCK_AND_RECOVER"; reason: "SEARCH_ALREADY_EXECUTED_THIS_TURN" | "NO_CALLER_TURN"; state: ReservationSearchAuthorityState }
  | { kind: "BLOCK_SILENT"; reason: "SEARCH_ALREADY_EXECUTED_THIS_TURN" | "NO_CALLER_TURN"; state: ReservationSearchAuthorityState };

export function initialReservationSearchAuthorityState(): ReservationSearchAuthorityState {
  return { currentTurnId: null, consumedTurnId: null, recoveryIssuedTurnId: null };
}

export function noteReservationSearchCallerTurn(
  state: ReservationSearchAuthorityState,
  turnId: string,
): ReservationSearchAuthorityState {
  const normalized = turnId.trim();
  if (!normalized || normalized === state.currentTurnId) return state;
  return {
    currentTurnId: normalized,
    consumedTurnId: state.consumedTurnId,
    recoveryIssuedTurnId: state.recoveryIssuedTurnId,
  };
}

export function decideReservationSearch(
  state: ReservationSearchAuthorityState,
): ReservationSearchDecision {
  const turnId = state.currentTurnId;
  if (!turnId) {
    if (state.recoveryIssuedTurnId === "__NO_CALLER_TURN__") {
      return { kind: "BLOCK_SILENT", reason: "NO_CALLER_TURN", state };
    }
    return {
      kind: "BLOCK_AND_RECOVER",
      reason: "NO_CALLER_TURN",
      state: { ...state, recoveryIssuedTurnId: "__NO_CALLER_TURN__" },
    };
  }

  if (state.consumedTurnId !== turnId) {
    return {
      kind: "ALLOW",
      state: { ...state, consumedTurnId: turnId, recoveryIssuedTurnId: null },
    };
  }

  if (state.recoveryIssuedTurnId !== turnId) {
    return {
      kind: "BLOCK_AND_RECOVER",
      reason: "SEARCH_ALREADY_EXECUTED_THIS_TURN",
      state: { ...state, recoveryIssuedTurnId: turnId },
    };
  }

  return {
    kind: "BLOCK_SILENT",
    reason: "SEARCH_ALREADY_EXECUTED_THIS_TURN",
    state,
  };
}
