export type ConversationLifecyclePort = Readonly<{
  confirmEndCall(reason: string, source: string): void;
  humanHandoffStarted(): void;
  transportClosed(reason: string): void;
  semanticIgnored(reason: string): void;
  validateUserTurn(source: string): void;
}>;

type LegacyLifecycleSession = {
  diagnostics?: { checkpoint?: (name: string, data?: Record<string, unknown>) => void };
  observeEndCallConfirmedV18?: (reason: string) => void;
  observeHumanHandoffStartedV18?: () => void;
  observeRealtimeTransportClosedV18?: (reason: string) => void;
  observeSemanticIgnoredV18?: (reason: string) => void;
  validateUserTurnV18?: (source: string) => void;
  beginClosing?: (reason: string, source: string) => void;
};

/**
 * Explicit compatibility port around the current lifecycle owner. No caller of
 * this port may know which historical CallSession generation implements it.
 * The legacy method adaptation is isolated here and can be deleted when V18 is
 * replaced by a composed lifecycle runtime.
 */
export function conversationLifecyclePortFor(session: object): ConversationLifecyclePort {
  const s = session as LegacyLifecycleSession;
  return Object.freeze({
    confirmEndCall(reason: string, source: string) {
      s.diagnostics?.checkpoint?.("CONVERSATION_LIFECYCLE_CLOSE_COMMITTED", {
        reason, source, authority: "conversation_lifecycle_port",
      });
      if (typeof s.observeEndCallConfirmedV18 === "function") s.observeEndCallConfirmedV18(reason);
      else s.beginClosing?.(reason, source);
    },
    humanHandoffStarted() { s.observeHumanHandoffStartedV18?.(); },
    transportClosed(reason: string) { s.observeRealtimeTransportClosedV18?.(reason); },
    semanticIgnored(reason: string) { s.observeSemanticIgnoredV18?.(reason); },
    validateUserTurn(source: string) { s.validateUserTurnV18?.(source); },
  });
}
