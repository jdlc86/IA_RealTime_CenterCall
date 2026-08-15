import { CallSession as CallSessionV28 } from "./call-session-v28";
import { CallSession as CallSessionV26 } from "./call-session-v26";
import { isPublicRestaurantTool } from "./public-tool-authorization";

const BaseConstructor = CallSessionV28 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV28.prototype as any;
const V26Prototype = CallSessionV26.prototype as any;
const INPUT_IGNORED = "restaurant_input_ignored";

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  transcript?: string;
  response_id?: string;
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

function usableTranscript(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, 1500);
}

function v29Instructions(session: any): string {
  const assistantName = typeof session.assistantName === "string" && session.assistantName.trim() ? session.assistantName.trim() : "Lucía";
  const businessName = typeof session.businessName === "string" && session.businessName.trim() ? session.businessName.trim() : "el restaurante";
  return `Eres ${assistantName}, agente telefónica de ${businessName}. Tú eres la única inteligencia que interpreta el contenido del usuario. Las señales VAD no son intención: solo una transcripción completada puede iniciar una decisión de tool.

TODO TURNO SIGNIFICATIVO: cuando recibas una transcripción que esté claramente dirigida a ti, selecciona exactamente la tool pública que representa esa intención antes de responder.

RUIDO Y FONDO: si la transcripción parece televisión, radio, eco, otra conversación, palabras sueltas, contenido incoherente o algo no dirigido a ti, usa restaurant_input_ignored. Esa tool no produce acción ni respuesta hablada. Ante duda entre ruido/fondo y una operación que modifica datos (cancelar, modificar, reservar, marketing), usa restaurant_input_ignored. Nunca conviertas audio ambiguo en una mutación.

ÁMBITO: atiende solo asuntos relacionados con ${businessName}. Si una petición está claramente dirigida a ti pero no pertenece al restaurante, usa restaurant_out_of_scope. Si pertenece al restaurante pero requiere una persona, usa restaurant_human_assistance.

AUTORIDAD: el backend es la única autoridad sobre datos y acciones. No afirmes que una reserva fue creada, modificada o cancelada hasta recibir el resultado correspondiente. confirm=true solo representa una confirmación explícita del usuario al cambio concreto que acabas de presentar.

RESPUESTAS: tras una tool comunica el resultado brevemente. No hables después de restaurant_input_ignored; simplemente espera otro turno.

CIERRE: una despedida inequívoca usa restaurant_end_call confirmed=true. El silencio y el ruido nunca significan cierre.`;
}

/**
 * v29 separates acoustic evidence from semantic evidence.
 *
 * speech_started remains available to the watchdog but is deliberately routed
 * below v27, so VAD can never force tool_choice=required. Only a completed,
 * non-empty transcription arms the tool-first domain gate. Lucia then decides
 * whether the transcript is a real restaurant turn, out of scope, or background
 * input via restaurant_input_ignored.
 *
 * It also prevents Lucia's own spoken transcript from validating a caller turn
 * and adds DEBUG traceability: user transcript -> tool+arguments -> tool output.
 */
export class CallSession extends BaseConstructor {
  private semanticGateArmedV29 = false;
  private observabilityInstalledV29 = false;
  private originalSendV29: ((message: unknown) => void) | null = null;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);

    if (isStart && response.ok) {
      this.installObservabilityV29();
      (this as any).send?.({
        type: "session.update",
        session: { type: "realtime", instructions: v29Instructions(this as any), tool_choice: "auto" },
      });
      (this as any).diagnostics?.checkpoint?.("SEMANTIC_TURN_GATE_V29_ENABLED", {
        vad_can_arm_tool_gate: false,
        transcript_required_to_arm: true,
        lucia_speech_can_validate_user_turn: false,
        ignored_input_tool: INPUT_IGNORED,
        debug_turn_trace: true,
      });
    }

    return response;
  }

  private debugEnabledV29(): boolean {
    return Boolean((this as any).diagnostics?.snapshot?.().enabled);
  }

  private installObservabilityV29(): void {
    if (this.observabilityInstalledV29) return;
    const currentSend = (this as any).send;
    if (typeof currentSend !== "function") return;
    this.observabilityInstalledV29 = true;
    this.originalSendV29 = currentSend.bind(this);
    (this as any).send = (message: any) => {
      if (this.debugEnabledV29() && message?.type === "conversation.item.create" && message?.item?.type === "function_call_output") {
        const output = typeof message.item.output === "string" ? message.item.output.slice(0, 2000) : JSON.stringify(message.item.output ?? {}).slice(0, 2000);
        (this as any).diagnostics?.checkpoint?.("DEBUG_TOOL_OUTPUT_V29", {
          call_id: message.item.call_id ?? null,
          output,
        });
      }
      this.originalSendV29?.(message);
    };
  }

  private armSemanticGateV29(transcript: string): void {
    if (this.semanticGateArmedV29 || (this as any).state === "closing" || (this as any).hangupStarted) return;
    this.semanticGateArmedV29 = true;
    (this as any).send?.({ type: "session.update", session: { type: "realtime", tool_choice: "required" } });
    (this as any).diagnostics?.checkpoint?.("RESTAURANT_SEMANTIC_TOOL_GATE_ARMED_V29", {
      source: "completed_transcription",
      transcript_length: transcript.length,
    });
  }

  private releaseSemanticGateV29(tool: string): void {
    if (!this.semanticGateArmedV29) return;
    this.semanticGateArmedV29 = false;
    (this as any).send?.({ type: "session.update", session: { type: "realtime", tool_choice: "auto" } });
    (this as any).diagnostics?.checkpoint?.("RESTAURANT_SEMANTIC_TOOL_GATE_RELEASED_V29", { tool });
  }

  private handleIgnoredInputV29(event: RealtimeEvent): void {
    let reason = "UNCERTAIN";
    try {
      const args = event.arguments?.trim() ? JSON.parse(event.arguments) as Record<string, unknown> : {};
      if (typeof args.reason === "string") reason = args.reason;
    } catch { /* fail safe */ }

    (this as any).diagnostics?.checkpoint?.("BACKGROUND_INPUT_IGNORED_V29", {
      reason,
      no_business_action: true,
      no_spoken_response: true,
    });
    (this as any).send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify({ ok: true, status: "IGNORED", reason, speak: false, mutation: false }),
      },
    });

    // v18 suspends on tool execution; this safe sink intentionally produces no
    // assistant audio, so return the watchdog to waiting state explicitly.
    (this as any).toolExecutionActiveV18 = false;
    (this as any).armWaitingForUserV18?.("background_input_ignored_v29");
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);

    // Acoustic evidence must still reach the watchdog, but MUST bypass v27's
    // speech_started -> tool_choice=required behavior.
    if (event?.type === "input_audio_buffer.speech_started") {
      await V26Prototype.handleRealtimeMessage.call(this, data);
      return;
    }

    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = usableTranscript(event.transcript);
      if (this.debugEnabledV29()) {
        (this as any).diagnostics?.checkpoint?.("DEBUG_USER_TRANSCRIPT_V29", {
          transcript: transcript ?? "",
          usable: transcript !== null,
        });
      }
      if (transcript) this.armSemanticGateV29(transcript);
    }

    // Never let Lucia's own speech satisfy the watchdog's semantic-user-turn
    // condition. Only caller transcript + subsequent agent tool can do that.
    if (event?.type === "response.output_audio_transcript.done") {
      (this as any).userTurnObservedV18 = false;
    }

    if (event?.type === "response.function_call_arguments.done" && event.name && isPublicRestaurantTool(event.name)) {
      if (this.debugEnabledV29()) {
        (this as any).diagnostics?.checkpoint?.("DEBUG_MODEL_TOOL_DECISION_V29", {
          tool: event.name,
          arguments: (event.arguments ?? "{}").slice(0, 2000),
          call_id: event.call_id ?? null,
        });
      }
      this.releaseSemanticGateV29(event.name);

      if (event.name === INPUT_IGNORED) {
        // v25 authorization sees this as a built-in runtime tool; execute it here
        // before older fallback handlers can treat it as missing.
        this.handleIgnoredInputV29(event);
        return;
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
