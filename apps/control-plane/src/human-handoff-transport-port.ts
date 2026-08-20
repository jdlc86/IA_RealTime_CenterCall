import { humanHandoffTransportRuntimeFor } from "./human-handoff-transport-runtime.js";

export type HumanHandoffTransportPort = Readonly<{
  cancelTransferWatchdog(): void;
  markTransferred(targetCallControlId: string | null): Promise<void>;
}>;

/** Version-neutral facade over the composed human-handoff transport runtime. */
export function humanHandoffTransportPortFor(session: object): HumanHandoffTransportPort {
  const runtime = humanHandoffTransportRuntimeFor(session);
  return Object.freeze({
    cancelTransferWatchdog() {
      runtime.cancelTransferWatchdog();
    },
    async markTransferred(targetCallControlId: string | null) {
      await runtime.markTransferred(session, targetCallControlId);
    },
  });
}
