import {
  initialResponseOwnerSnapshot,
  reduceResponseOwner,
  type ResponseOwnerEffect,
  type ResponseOwnerEvent,
  type ResponseOwnerSnapshot,
} from "./realtime-response-owner.js";
import { decideResponseOwnerEmission, type ResponseOwnerEmissionMode } from "./response-owner-emission-policy.js";
import { applyBargeInSemanticDecision } from "./response-owner-barge-in-decision.js";

export type ResponseReconciliation = Readonly<{
  accepted: boolean;
  previous: ResponseOwnerSnapshot;
  snapshot: ResponseOwnerSnapshot;
  effects: readonly ResponseOwnerEffect[];
  executable: readonly ResponseOwnerEffect[];
  observedOnly: readonly ResponseOwnerEffect[];
}>;

/** Single owner of realtime response ownership state for a call. */
export class ResponseCoordinator {
  private owner: ResponseOwnerSnapshot = initialResponseOwnerSnapshot();

  snapshot(): ResponseOwnerSnapshot { return this.owner; }

  reconcile(event: ResponseOwnerEvent, mode: ResponseOwnerEmissionMode = "active"): ResponseReconciliation {
    const previous = this.owner;
    const result = reduceResponseOwner(previous, event);
    this.owner = result.snapshot;
    const emission = decideResponseOwnerEmission(result.effects, mode);
    return Object.freeze({
      accepted: true,
      previous,
      snapshot: result.snapshot,
      effects: result.effects,
      executable: emission.executable,
      observedOnly: emission.observedOnly,
    });
  }

  applyBargeInDecision(decision: "INTERRUPT" | "IGNORE", mode: ResponseOwnerEmissionMode = "active"): ResponseReconciliation {
    const previous = this.owner;
    const result = applyBargeInSemanticDecision(previous, decision);
    if (result.accepted) this.owner = result.snapshot;
    const emission = decideResponseOwnerEmission(result.effects, mode);
    return Object.freeze({
      accepted: result.accepted,
      previous,
      snapshot: result.snapshot,
      effects: result.effects,
      executable: emission.executable,
      observedOnly: emission.observedOnly,
    });
  }
}

const coordinators = new WeakMap<object, ResponseCoordinator>();
export function responseCoordinatorFor(session: object): ResponseCoordinator {
  let coordinator = coordinators.get(session);
  if (!coordinator) { coordinator = new ResponseCoordinator(); coordinators.set(session, coordinator); }
  return coordinator;
}
