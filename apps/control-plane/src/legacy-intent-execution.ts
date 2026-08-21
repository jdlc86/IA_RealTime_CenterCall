export const LEGACY_INTENT_EXECUTOR: unique symbol = Symbol("legacy-intent-executor");

export type LegacyIntentSelection = Readonly<{
  argumentsJson?: string;
  callId?: string;
}>;

export type LegacyIntentExecutor = {
  [LEGACY_INTENT_EXECUTOR](selection: LegacyIntentSelection): Promise<void>;
};

/**
 * Delegates a provider-neutral legacy intent to the next executor in the
 * historical composition chain. Provider event encoding never crosses this
 * capability boundary.
 */
export async function executeLegacyIntent(
  executorPrototype: object,
  session: object,
  selection: LegacyIntentSelection,
): Promise<void> {
  const executor = (executorPrototype as Partial<LegacyIntentExecutor>)[LEGACY_INTENT_EXECUTOR];
  if (typeof executor !== "function") throw new Error("Legacy intent executor is not installed");
  await executor.call(session, selection);
}
