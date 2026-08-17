import { CallSession as CallSessionV28 } from "./call-session-v28";
import { CallSession as CallSessionV26 } from "./call-session-v26";
import { isPublicRestaurantTool } from "./public-tool-authorization";
import { realtimeCommandPortFor } from "./openai-realtime-command-adapter";

const BaseConstructor = CallSessionV28 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV28.prototype as any;
const V26Prototype = CallSessionV26.prototype as any;
const INPUT_IGNORED = "restaurant_input_ignored";

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  item_id?: string;
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
  return `Eres ${assistantName}, agente telefónica de ${businessName}. Tú eres la única inteligencia que interpreta el contenido del usuario. Las señales VAD no son intención: solo una transcripción completada puede iniciar una decisión de tool.\n\nTODO TURNO SIGNIFICATIVO: cuando recibas una transcripción que esté claramente dirigida a ti, selecciona exactamente la tool pública que representa esa intención antes de responder.\n\nRUIDO Y FONDO: si la transcripción parece televisión, radio, eco, otra conversación, palabras sueltas, contenido incoherente o algo no dirigido a ti, usa restaurant_input_ignored. Esa tool no produce acción ni respuesta hablada. Ante duda entre ruido/fondo y una operación que modifica datos (cancelar, modificar, reservar, marketing), usa restaurant_input_ignored. Nunca conviertas audio ambiguo en una mutación.\n\nÁMBITO: atiende solo asuntos relacionados con ${businessName}. Si una petición está claramente dirigida a ti pero no pertenece al restaurante, usa restaurant_out_of_scope. Si pertenece al restaurante pero requiere una persona, usa restaurant_human_assistance.\n\nAUTORIDAD: el backend es la única autoridad sobre datos y acciones. No afirmes que una reserva fue creada, modificada o cancelada hasta recibir el resultado correspondiente. confirm=true solo representa una confirmación explícita del usuario al cambio concreto que acabas de presentar.\n\nRESPUESTAS: tras una tool comunica el resultado brevemente. No hables después de restaurant_input_ignored; simplemente espera otro turno.\n\nCIERRE: una despedida inequívoca usa restaurant_end_call confirmed=true. El silencio y el ruido nunca significan cierre.`;
}

export class CallSession extends BaseConstructor {
  private semanticGateArmedV29 = false;
  private observabilityInstalledV29 = false;
  private originalSendV29: ((message: unknown) => void) | null = null;
  private callerDirectedItemIdV29: string | null = null;
  private activeSemanticItemIdV29: string | null = null;

  protected armCallerDirectedSemanticAuthorityV29(itemId: string, source: string): void {
    if (!itemId || (this as any).state === "closing" || (this as any).hangupStarted) return;
    this.callerDirectedItemIdV29 = itemId;
    (this as any).diagnostics?.checkpoint?.("CALLER_DIRECTED_SEMANTIC_AUTHORITY_ARMED_V29", {
      item_id: itemId,
      source,
      one_shot: true,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok) {
      this.installObservabilityV29();
      (this as any).send?.({ type: "session.update", session: { type: "realtime", instructions: v29Instructions(this as any), tool_choice: "auto" } });
      (this as any).diagnostics?.checkpoint?.("SEMANTIC_TURN_GATE_V29_ENABLED", {
        vad_can_arm_tool_gate: false,
        transcript_required_to_arm: true,
        lucia_speech_can_validate_user_turn: false,
        ignored_input_tool: INPUT_IGNORED,
        debug_turn_trace: true,
        presence_authority: "ConversationTurnLifecycle",
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
        (this as any).diagnostics?.checkpoint?.("DEBUG_TOOL_OUTPUT_V29", { call_id: message.item.call_id ?? null, output });
      }
      this.originalSendV29?.(message);
    };
  }

  private armSemanticGateV29(transcript: string, itemId: string | null): void {
    if (this.semanticGateArmedV29 || (this as any).state === "closing" || (this as any).hangupStarted) return;
    this.semanticGateArmedV29 = true;
    this.activeSemanticItemIdV29 = itemId;
    (this as any).send?.({ type: "session.update", session: { type: "realtime", tool_choice: "required" } });
    (this as any).diagnostics?.checkpoint?.("RESTAURANT_SEMANTIC_TOOL_GATE_ARMED_V29", {
      source: "completed_transcription",
      transcript_length: transcript.length,
      item_id: itemId,
      caller_directed_authority: Boolean(itemId && itemId === this.callerDirectedItemIdV29),
    });
  }

  private releaseSemanticGateV29(tool: string): void {
    if (!this.semanticGateArmedV29) return;
    this.semanticGateArmedV29 = false;
    this.activeSemanticItemIdV29 = null;
    this.callerDirectedItemIdV29 = null;
    (this as any).send?.({ type: "session.update", session: { type: "realtime", tool_choice: "auto" } });
    (this as any).diagnostics?.checkpoint?.("RESTAURANT_SEMANTIC_TOOL_GATE_RELEASED_V29", { tool });
  }

  private callerDirectedAuthorityAppliesV29(): boolean {
    return Boolean(this.semanticGateArmedV29 && this.activeSemanticItemIdV29 && this.callerDirectedItemIdV29 === this.activeSemanticItemIdV29);
  }

  private rejectIgnoredInputForDirectedTurnV29(event: RealtimeEvent): void {
    (this as any).diagnostics?.checkpoint?.("BACKGROUND_INPUT_RECLASSIFICATION_BLOCKED_V29", {
      item_id: this.activeSemanticItemIdV29,
      model_tool: INPUT_IGNORED,
      authority: "caller_directed_barge_in_classifier",
      semantic_gate_preserved: true,
      presence_unchanged: true,
    });
    (this as any).send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify({
          ok: false,
          status: "REJECTED",
          reason: "CALLER_DIRECTED_TURN_CONFIRMED",
          instruction: "The caller-directed turn is already authoritative. Select the appropriate public restaurant tool for the same user turn; do not use restaurant_input_ignored.",
        }),
      },
    });
    realtimeCommandPortFor(this as any).createDefaultResponse();
  }

  private handleIgnoredInputV29(event: RealtimeEvent): void {
    let reason = "UNCERTAIN";
    try {
      const args = event.arguments?.trim() ? JSON.parse(event.arguments) as Record<string, unknown> : {};
      if (typeof args.reason === "string" && args.reason.trim()) reason = args.reason.trim();
    } catch { /* fail safe */ }
    (this as any).diagnostics?.checkpoint?.("BACKGROUND_INPUT_IGNORED_V29", { reason, no_business_action: true, no_spoken_response: true, lifecycle_authority: true });
    (this as any).send?.({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify({ ok: true, status: "IGNORED", reason, speak: false, mutation: false }) },
    });
    this.activeSemanticItemIdV29 = null;
    this.callerDirectedItemIdV29 = null;
    (this as any).observeSemanticIgnoredV18?.(reason);
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);
    if (event?.type === "input_audio_buffer.speech_started") {
      await V26Prototype.handleRealtimeMessage.call(this, data);
      return;
    }

    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = usableTranscript(event.transcript);
      if (this.debugEnabledV29()) {
        (this as any).diagnostics?.checkpoint?.("DEBUG_USER_TRANSCRIPT_V29", { transcript: transcript ?? "", usable: transcript !== null });
      }
      if (transcript) {
        const itemId = typeof event.item_id === "string" ? event.item_id : null;
        const higherLayerOwns = Boolean((this as any).shouldBypassTurnConcurrencyV36?.(event));
        if (itemId && higherLayerOwns) this.armCallerDirectedSemanticAuthorityV29(itemId, "higher_layer_confirmed_turn_ownership");
        this.armSemanticGateV29(transcript, itemId);
      }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name && isPublicRestaurantTool(event.name)) {
      if (this.debugEnabledV29()) {
        (this as any).diagnostics?.checkpoint?.("DEBUG_MODEL_TOOL_DECISION_V29", {
          tool: event.name,
          arguments: (event.arguments ?? "{}").slice(0, 2000),
          call_id: event.call_id ?? null,
        });
      }
      if (event.name === INPUT_IGNORED && this.callerDirectedAuthorityAppliesV29()) {
        this.rejectIgnoredInputForDirectedTurnV29(event);
        return;
      }
      this.releaseSemanticGateV29(event.name);
      if (event.name === INPUT_IGNORED) {
        this.handleIgnoredInputV29(event);
        return;
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
