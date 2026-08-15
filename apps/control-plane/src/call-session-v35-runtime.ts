import { CallSession as CallSessionV35 } from "./call-session-v35";

const BaseConstructor = CallSessionV35 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV35.prototype as any;
const CALLSESSION_RUNTIME_FINGERPRINT = "v35-protected-speech-runtime-2026-08-15-b";

type RealtimeSessionEvent = {
  type?: string;
  session?: {
    audio?: {
      input?: {
        turn_detection?: {
          type?: string;
          threshold?: number;
          prefix_padding_ms?: number;
          silence_duration_ms?: number;
          idle_timeout_ms?: number;
          create_response?: boolean;
          interrupt_response?: boolean;
        } | null;
      };
    };
  };
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function parseRealtimeEvent(data: unknown): RealtimeSessionEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try {
    return JSON.parse(text) as RealtimeSessionEvent;
  } catch {
    return null;
  }
}

/**
 * Temporary deployment/lifecycle diagnostic wrapper.
 *
 * This class does not alter Realtime, VAD, tools, watchdogs, or protected-speech
 * behavior. It records:
 * - an unambiguous runtime fingerprint after /start;
 * - the effective turn_detection state echoed by session.created/session.updated;
 * - whether caller speech_started occurred while protected speech was active.
 */
export class CallSession extends BaseConstructor {
  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);

    if (isStart && response.ok) {
      (this as any).diagnostics?.checkpoint?.("CALLSESSION_RUNTIME_FINGERPRINT_V35", {
        fingerprint: CALLSESSION_RUNTIME_FINGERPRINT,
      });
    }

    return response;
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseRealtimeEvent(data);

    if (event?.type === "session.created" || event?.type === "session.updated") {
      const turnDetection = event.session?.audio?.input?.turn_detection;
      (this as any).diagnostics?.checkpoint?.("REALTIME_TURN_DETECTION_EFFECTIVE_V35", {
        event_type: event.type,
        turn_detection_present: turnDetection !== undefined,
        turn_detection_disabled: turnDetection === null,
        turn_detection_type: turnDetection && typeof turnDetection === "object" ? turnDetection.type ?? null : null,
        interrupt_response: turnDetection && typeof turnDetection === "object" ? turnDetection.interrupt_response ?? null : null,
        create_response: turnDetection && typeof turnDetection === "object" ? turnDetection.create_response ?? null : null,
        threshold: turnDetection && typeof turnDetection === "object" ? turnDetection.threshold ?? null : null,
        prefix_padding_ms: turnDetection && typeof turnDetection === "object" ? turnDetection.prefix_padding_ms ?? null : null,
        silence_duration_ms: turnDetection && typeof turnDetection === "object" ? turnDetection.silence_duration_ms ?? null : null,
        idle_timeout_ms: turnDetection && typeof turnDetection === "object" ? turnDetection.idle_timeout_ms ?? null : null,
      });
    }

    if (event?.type === "input_audio_buffer.speech_started") {
      const protectedSnapshot = (this as any).protectedSpeechLifecycleV35?.snapshot?.() ?? null;
      (this as any).diagnostics?.checkpoint?.("CALLER_SPEECH_DURING_PROTECTED_STATE_V35", {
        protected_active: Boolean(protectedSnapshot),
        protected_kind: protectedSnapshot?.kind ?? null,
        protected_response_id: protectedSnapshot?.responseId ?? null,
      });
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
