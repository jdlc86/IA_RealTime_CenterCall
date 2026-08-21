export type ClassifierBootstrapOwner =
  | "RESERVATION_V5"
  | "RESERVATION_V6"
  | "MARKETING_V7"
  | "QUERY_V11"
  | "CORE_INTENT_V13"
  | "DIRECT_AGENT_V26";

const ownerPriority: Readonly<Record<ClassifierBootstrapOwner, number>> = Object.freeze({
  RESERVATION_V5: 5,
  RESERVATION_V6: 6,
  MARKETING_V7: 7,
  QUERY_V11: 11,
  CORE_INTENT_V13: 13,
  DIRECT_AGENT_V26: 26,
});

const ownerBySession = new WeakMap<object, ClassifierBootstrapOwner>();

/**
 * Selects the highest classifier authority present in a composed CallSession.
 * Newer layers claim before delegating fetch(), so older layers can decide
 * locally whether their historical session.update still owns bootstrap.
 */
export function claimClassifierBootstrap(
  session: object,
  candidate: ClassifierBootstrapOwner,
): ClassifierBootstrapOwner {
  const current = ownerBySession.get(session);
  if (!current || ownerPriority[candidate] > ownerPriority[current]) {
    ownerBySession.set(session, candidate);
    return candidate;
  }
  return current;
}

export function ownsClassifierBootstrap(
  session: object,
  candidate: ClassifierBootstrapOwner,
): boolean {
  return ownerBySession.get(session) === candidate;
}

export function classifierBootstrapOwner(session: object): ClassifierBootstrapOwner | null {
  return ownerBySession.get(session) ?? null;
}
