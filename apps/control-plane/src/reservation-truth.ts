export type ReservationClaim = "RESERVATION_CREATED" | "RESERVATION_IS_BOOKED" | "RESERVATION_CANCELLED";

export type ReservationEvidence =
  | { source: "CREATE_RESULT"; status: "BOOKED" }
  | { source: "QUERY_RESULT"; status: "BOOKED" }
  | { source: "CANCEL_RESULT"; status: "CANCELLED" };

export type ReservationClaimDecision = {
  allowed: boolean;
  reason: "EVIDENCE_MATCH" | "EVIDENCE_MISSING" | "EVIDENCE_MISMATCH";
};

/**
 * Deterministic assertion guard. It never reads or interprets natural language.
 * A claim is allowed only when an authoritative backend result supports it.
 */
export function authorizeReservationClaim(
  claim: ReservationClaim,
  evidence: ReservationEvidence | null | undefined,
): ReservationClaimDecision {
  if (!evidence) return { allowed: false, reason: "EVIDENCE_MISSING" };

  if (claim === "RESERVATION_CREATED") {
    return evidence.source === "CREATE_RESULT" && evidence.status === "BOOKED"
      ? { allowed: true, reason: "EVIDENCE_MATCH" }
      : { allowed: false, reason: "EVIDENCE_MISMATCH" };
  }

  if (claim === "RESERVATION_IS_BOOKED") {
    return evidence.status === "BOOKED" && (evidence.source === "CREATE_RESULT" || evidence.source === "QUERY_RESULT")
      ? { allowed: true, reason: "EVIDENCE_MATCH" }
      : { allowed: false, reason: "EVIDENCE_MISMATCH" };
  }

  return evidence.source === "CANCEL_RESULT" && evidence.status === "CANCELLED"
    ? { allowed: true, reason: "EVIDENCE_MATCH" }
    : { allowed: false, reason: "EVIDENCE_MISMATCH" };
}
