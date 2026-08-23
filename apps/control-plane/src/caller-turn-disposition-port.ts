export type CallerTurnDisposition = "NORMAL" | "INTERRUPT" | "IGNORE";

export type CallerTurnDispositionRequest = Readonly<{
  itemId: string;
  disposition: CallerTurnDisposition;
}>;

/**
 * Neutral effect boundary used only after semantic authority has resolved a
 * deferred caller turn. It owns no classifier and never infers intent itself.
 */
export interface CallerTurnDispositionPort {
  resolve(request: CallerTurnDispositionRequest): void;
}

export function requireCallerTurnDispositionRequest(value: CallerTurnDispositionRequest): CallerTurnDispositionRequest {
  const itemId = typeof value?.itemId === "string" ? value.itemId.trim() : "";
  if (!itemId) throw new Error("Caller turn disposition requires itemId");
  if (!["NORMAL", "INTERRUPT", "IGNORE"].includes(value?.disposition)) {
    throw new Error("Caller turn disposition is invalid");
  }
  return Object.freeze({ itemId, disposition: value.disposition });
}
