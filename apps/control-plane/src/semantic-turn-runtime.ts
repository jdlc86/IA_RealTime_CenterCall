import {
  beginSemanticCallerTurn,
  initialSemanticTurnDecisionState,
  selectSemanticTool,
  shouldArmSemanticGateAfterTranscript,
  shouldBeginSemanticTurnForTranscript,
  shouldReopenSemanticTurnAfterProvisionalIgnore,
  type SemanticTurnDecisionState,
} from "./semantic-turn-decision-policy.js";
import { shouldBlockIgnoredInputForDirectedTurn } from "./directed-turn-authority.js";

export type SemanticToolSelection = Readonly<{
  allowed: boolean;
  duplicateOf: string | null;
}>;

export type SemanticTurnSnapshot = Readonly<{
  gateArmed: boolean;
  activeItemId: string | null;
  directedItemId: string | null;
  selectedTool: string | null;
}>;

/**
 * Single in-call owner for semantic-turn bookkeeping. It contains no provider
 * commands and no CallSession-version knowledge; adapters translate its decisions
 * into session/tool commands.
 */
export class SemanticTurnRuntime {
  private gateArmed = false;
  private directedItemId: string | null = null;
  private activeItemId: string | null = null;
  private decision: SemanticTurnDecisionState = initialSemanticTurnDecisionState();

  snapshot(): SemanticTurnSnapshot {
    return Object.freeze({
      gateArmed: this.gateArmed,
      activeItemId: this.activeItemId,
      directedItemId: this.directedItemId,
      selectedTool: this.decision.selectedTool,
    });
  }

  beginFromAcousticEvidence(): void {
    this.decision = beginSemanticCallerTurn();
    this.gateArmed = false;
    this.activeItemId = null;
    this.directedItemId = null;
  }

  beginFreshTurn(): void {
    this.decision = beginSemanticCallerTurn();
  }

  armDirected(itemId: string): void {
    if (itemId) this.directedItemId = itemId;
  }

  shouldReopenAfterProvisionalIgnore(ignoredTool: string): boolean {
    return shouldReopenSemanticTurnAfterProvisionalIgnore(this.decision, ignoredTool);
  }

  shouldBeginForTranscript(higherLayerOwns: boolean): boolean {
    return shouldBeginSemanticTurnForTranscript(this.decision, higherLayerOwns);
  }

  shouldArmGateAfterTranscript(): boolean {
    return shouldArmSemanticGateAfterTranscript(this.decision);
  }

  armGate(itemId: string | null): boolean {
    if (this.gateArmed) return false;
    this.gateArmed = true;
    this.activeItemId = itemId;
    return true;
  }

  releaseGate(): boolean {
    if (!this.gateArmed) return false;
    this.gateArmed = false;
    this.activeItemId = null;
    this.directedItemId = null;
    return true;
  }

  directedAuthorityApplies(): boolean {
    return shouldBlockIgnoredInputForDirectedTurn({
      semanticGateArmed: this.gateArmed,
      activeItemId: this.activeItemId,
      directedItemId: this.directedItemId,
    });
  }

  selectTool(tool: string): SemanticToolSelection {
    const result = selectSemanticTool(this.decision, tool);
    this.decision = result.next;
    return Object.freeze({ allowed: result.allowed, duplicateOf: result.duplicateOf });
  }

  clearItemAuthority(): void {
    this.activeItemId = null;
    this.directedItemId = null;
  }
}

const runtimes = new WeakMap<object, SemanticTurnRuntime>();

export function semanticTurnRuntimeFor(session: object): SemanticTurnRuntime {
  let runtime = runtimes.get(session);
  if (!runtime) {
    runtime = new SemanticTurnRuntime();
    runtimes.set(session, runtime);
  }
  return runtime;
}
