export type SidebandCloseObservation = Readonly<{
  reason: "sideband_closed" | "socket_absent_after_start";
  closeCode: number | null;
  providerReason: string;
  wasClean: boolean | null;
}>;

export type SidebandCloseObserver = (observation: SidebandCloseObservation) => void | Promise<void>;

/** Explicit composition point between the sideband wire and conversation lifecycle. */
export class SidebandLifecyclePort {
  private closeObserver: SidebandCloseObserver | null = null;

  installCloseObserver(observer: SidebandCloseObserver): void {
    if (this.closeObserver && this.closeObserver !== observer) {
      throw new Error("Sideband close observer is already installed");
    }
    this.closeObserver = observer;
  }

  async transportClosed(observation: SidebandCloseObservation): Promise<void> {
    await this.closeObserver?.(observation);
  }
}

const ports = new WeakMap<object, SidebandLifecyclePort>();

export function sidebandLifecyclePortFor(session: object): SidebandLifecyclePort {
  let port = ports.get(session);
  if (!port) {
    port = new SidebandLifecyclePort();
    ports.set(session, port);
  }
  return port;
}
