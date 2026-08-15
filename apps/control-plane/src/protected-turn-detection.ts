export type TenantVadSettings = {
  threshold?: number;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  idleTimeoutMs?: number;
};

export type RealtimeServerVad = {
  type: "server_vad";
  threshold: number;
  prefix_padding_ms: number;
  silence_duration_ms: number;
  idle_timeout_ms: number;
  create_response: true;
  interrupt_response: true;
};

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_PREFIX_PADDING_MS = 300;
const DEFAULT_SILENCE_DURATION_MS = 500;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;

export function buildServerVad(settings: TenantVadSettings = {}): RealtimeServerVad {
  return {
    type: "server_vad",
    threshold: settings.threshold ?? DEFAULT_THRESHOLD,
    prefix_padding_ms: settings.prefixPaddingMs ?? DEFAULT_PREFIX_PADDING_MS,
    silence_duration_ms: settings.silenceDurationMs ?? DEFAULT_SILENCE_DURATION_MS,
    idle_timeout_ms: settings.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    create_response: true,
    interrupt_response: true,
  };
}

export function suspendTurnDetectionEvent(): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      audio: {
        input: {
          turn_detection: null,
        },
      },
    },
  };
}

export function restoreTurnDetectionEvent(settings: TenantVadSettings = {}): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      audio: {
        input: {
          turn_detection: buildServerVad(settings),
        },
      },
    },
  };
}
