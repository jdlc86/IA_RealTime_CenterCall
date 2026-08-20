export type HumanHandoffTransportPort = Readonly<{
  cancelTransferWatchdog(): void;
  markTransferred(targetCallControlId: string | null): Promise<void>;
}>;

type LegacyHumanHandoffTransportSession = {
  clearTransferWatchdogV37?: () => void;
  markHandoffTransferredV37?: (targetCallControlId: string | null) => Promise<void> | void;
};

/**
 * Compatibility port around the current human-handoff transport owner.
 * CallSession consolidation layers must depend on this version-neutral contract,
 * never on a historical CallSession generation directly. The legacy adaptation
 * is intentionally isolated here and can disappear when handoff transport moves
 * to a composed runtime.
 */
export function humanHandoffTransportPortFor(session: object): HumanHandoffTransportPort {
  const transport = session as LegacyHumanHandoffTransportSession;
  return Object.freeze({
    cancelTransferWatchdog() {
      transport.clearTransferWatchdogV37?.();
    },
    async markTransferred(targetCallControlId: string | null) {
      await transport.markHandoffTransferredV37?.(targetCallControlId);
    },
  });
}
