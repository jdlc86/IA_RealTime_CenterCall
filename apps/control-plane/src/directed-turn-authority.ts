export type DirectedTurnAuthorityInput = {
  semanticGateArmed: boolean;
  activeItemId: string | null;
  directedItemId: string | null;
};

/**
 * Once a higher layer has proven that a specific transcript item is directed at
 * the assistant, the same semantic turn cannot be downgraded to background.
 * Authority is item-scoped and one-shot; unrelated turns remain unaffected.
 */
export function shouldBlockIgnoredInputForDirectedTurn(input: DirectedTurnAuthorityInput): boolean {
  return Boolean(
    input.semanticGateArmed &&
    input.activeItemId &&
    input.directedItemId &&
    input.activeItemId === input.directedItemId
  );
}
