import { CallSession as CallSessionV34 } from "./call-session-v34";

const BaseConstructor = CallSessionV34 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV34.prototype as any;

const INPUT_IGNORED = "restaurant_input_ignored";
const RECOVERY_WINDOW_MS = 10_000;
const RECOVERY_THRESHOLD = 2;
const RECOVERY_MESSAGE = "Estoy teniendo dificultad para distinguir si me estás hablando a mí debido al ruido o a otras voces de fondo. Continuamos, ¿en qué puedo ayudarte?";

type RealtimeEvent = {
  type?: string;
  name?: string;
  arguments?: string;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function parseEvent(data: unknown): RealtimeEvent | null {
  const text = readRealtimeText(data);
  if (!text) return null;
  try { return JSON.parse(text) as RealtimeEvent; } catch { return null; }
}

function ignoredReason(event: RealtimeEvent): string {
  try {
    const args = event.arguments?.trim() ? JSON.parse(event.arguments) as Record<string, unknown> : {};
    return typeof args.reason === "string" ? args.reason : "UNCERTAIN";
  } catch {
    return "UNCERTAIN";
  }
}

/**
 * v35 protects critical assistant speech from acoustic barge-in.
 *
 * - The initial greeting is the first response.create emitted during /start and
 *   is wrapped with interrupt_response=false before it is created.
 * - After the greeting audio completes, normal interruption is restored.
 * - Repeated ignored/background inputs trigger one explicit recovery message.
 *   That message is also protected until its audio is complete, then normal
 *   interruption is restored and the turn is returned to the caller.
 *
 * VAD continues to observe audio while speech is protected; it simply cannot
 * cancel Lucia's protected response.
 */
export class CallSession extends BaseConstructor {
  private sendWrappedV35 = false;
  private originalSendV35: ((message: unknown) => void) | null = null;
  private greetingProtectionPendingV35 = true;
  private protectedSpeechV35: "GREETING" | "RECOVERY" | null = null;
  private ignoredEventsV35: number[] = [];
  private recoveryInFlightV35 = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    if (isStart) this.installSendProtectionV35();
    const response = await super.fetch(request);
    if (isStart && response.ok) {
      (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_POLICY_V35_ENABLED", {
        greeting_uninterruptible: true,
        recovery_uninterruptible: true,
        recovery_threshold: RECOVERY_THRESHOLD,
        recovery_window_ms: RECOVERY_WINDOW_MS,
      });
    }
    return response;
  }

  private installSendProtectionV35(): void {
    if (this.sendWrappedV35) return;
    const currentSend = (this as any).send;
    if (typeof currentSend !== "function") return;
    this.sendWrappedV35 = true;
    this.originalSendV35 = currentSend.bind(this);

    (this as any).send = (message: any) => {
      if (this.greetingProtectionPendingV35 && message?.type === "response.create") {
        this.greetingProtectionPendingV35 = false;
        this.setInterruptResponseV35(false, "greeting_start");
        this.protectedSpeechV35 = "GREETING";
        (this as any).diagnostics?.checkpoint?.("PROTECTED_GREETING_STARTED_V35", {
          interrupt_response: false,
        });
      }
      this.originalSendV35?.(message);
    };
  }

  private setInterruptResponseV35(enabled: boolean, reason: string): void {
    this.originalSendV35?.({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              interrupt_response: enabled,
            },
          },
        },
      },
    });
    (this as any).diagnostics?.checkpoint?.("INTERRUPT_RESPONSE_CHANGED_V35", {
      interrupt_response: enabled,
      reason,
    });
  }

  private startProtectedRecoveryV35(): void {
    if (this.recoveryInFlightV35 || this.protectedSpeechV35 || (this as any).state === "closing" || (this as any).hangupStarted) return;
    this.recoveryInFlightV35 = true;
    this.protectedSpeechV35 = "RECOVERY";
    this.setInterruptResponseV35(false, "recovery_start");
    (this as any).send?.({
      type: "response.create",
      response: {
        tool_choice: "none",
        instructions: `Pronuncia exactamente esta frase completa y nada más: ${JSON.stringify(RECOVERY_MESSAGE)}`,
      },
    });
    (this as any).diagnostics?.checkpoint?.("PROTECTED_RECOVERY_STARTED_V35", {
      interrupt_response: false,
      message: RECOVERY_MESSAGE,
    });
  }

  private noteIgnoredInputV35(reason: string): void {
    const now = Date.now();
    this.ignoredEventsV35 = this.ignoredEventsV35.filter((timestamp) => now - timestamp <= RECOVERY_WINDOW_MS);
    this.ignoredEventsV35.push(now);
    (this as any).diagnostics?.checkpoint?.("IGNORED_INPUT_COUNTED_V35", {
      reason,
      count_in_window: this.ignoredEventsV35.length,
      recovery_threshold: RECOVERY_THRESHOLD,
    });
    if (this.ignoredEventsV35.length >= RECOVERY_THRESHOLD) {
      this.ignoredEventsV35 = [];
      this.startProtectedRecoveryV35();
    }
  }

  private finishProtectedSpeechV35(): void {
    const kind = this.protectedSpeechV35;
    if (!kind) return;
    this.protectedSpeechV35 = null;
    if (kind === "RECOVERY") this.recoveryInFlightV35 = false;
    this.setInterruptResponseV35(true, `${kind.toLowerCase()}_complete`);
    (this as any).diagnostics?.checkpoint?.("PROTECTED_SPEECH_COMPLETED_V35", {
      kind,
      interrupt_response: true,
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);

    if (event?.type === "response.function_call_arguments.done" && event.name === INPUT_IGNORED) {
      const reason = ignoredReason(event);
      await BasePrototype.handleRealtimeMessage.call(this, data);
      this.noteIgnoredInputV35(reason);
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);

    if (event?.type === "response.output_audio.done" && this.protectedSpeechV35) {
      this.finishProtectedSpeechV35();
    }
  }
}
