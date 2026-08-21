import { CallSession as CallSessionV28 } from "./call-session-v28";
import { CallSession as CallSessionV26 } from "./call-session-v26";
import { isPublicRestaurantTool } from "./public-tool-authorization";
import {
  adaptRealtimeProviderEvents,
  installRealtimeToolResultObserver,
  realtimeAssistantResponseActiveFor,
  realtimeCommandPortFor,
} from "./realtime-provider-runtime.js";
import {
  armCallerDirectedSemanticAuthority,
  armSemanticGate,
  beginSemanticTurnFromAcousticEvidence,
} from "./semantic-turn-coordinator.js";
import { publicRestaurantToolAuthorizationPortFor } from "./semantic-tool-authorization-port.js";
import { semanticTurnRuntimeFor } from "./semantic-turn-runtime.js";
import { turnOwnershipRuntimeFor } from "./turn-ownership-runtime.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { isPureGreetingTurn } from "./conversational-turn-policy.js";

const BaseConstructor = CallSessionV28 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV28.prototype as any;
const V26Prototype = CallSessionV26.prototype as any;
const INPUT_IGNORED = "restaurant_input_ignored";
const PURE_GREETING_REPLY = "Hola, ¿en qué puedo ayudarte?";

type SemanticToolEventV29 = {
  name: string;
  call_id?: string;
  arguments?: string;
};

function usableTranscript(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 1500) : null;
}

function v29Instructions(session: any): string {
  const assistantName = typeof session.assistantName === "string" && session.assistantName.trim() ? session.assistantName.trim() : "Lucía";
  const businessName = typeof session.businessName === "string" && session.businessName.trim() ? session.businessName.trim() : "el restaurante";
  return `Eres ${assistantName}, agente telefónica de ${businessName}. Tú eres la única inteligencia que interpreta el contenido del usuario. Las señales VAD no son intención: solo una transcripción completada puede iniciar una decisión de tool.\n\nTODO TURNO SIGNIFICATIVO: cuando recibas una transcripción que esté claramente dirigida a ti, selecciona exactamente la tool pública que representa esa intención antes de responder.\n\nRUIDO Y FONDO: si la transcripción parece televisión, radio, eco, otra conversación, palabras sueltas, contenido incoherente o algo no dirigido a ti, usa restaurant_input_ignored. Esa tool no produce acción ni respuesta hablada. Ante duda entre ruido/fondo y una operación que modifica datos (cancelar, modificar, reservar, marketing), usa restaurant_input_ignored. Nunca conviertas audio ambiguo en una mutación.\n\nÁMBITO: atiende solo asuntos relacionados con ${businessName}. Si una petición está claramente dirigida a ti pero no pertenece al restaurante, usa restaurant_out_of_scope. Si pertenece al restaurante pero requiere una persona, usa restaurant_human_assistance.\n\nAUTORIDAD: el backend es la única autoridad sobre datos y acciones. No afirmes que una reserva fue creada, modificada o cancelada hasta recibir el resultado correspondiente. confirm=true solo representa una confirmación explícita del usuario al cambio concreto que acabas de presentar.\n\nRESPUESTAS: tras una tool comunica el resultado brevemente. No hables después de restaurant_input_ignored; simplemente espera otro turno.\n\nCIERRE: una despedida inequívoca usa restaurant_end_call confirmed=true. El silencio y el ruido nunca significan cierre.`;
}

export class CallSession extends BaseConstructor {
  private observabilityInstalledV29 = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok) {
      this.installObservabilityV29();
      realtimeCommandPortFor(this as any).updateSessionPolicy({
        instructions: v29Instructions(this as any),
        toolChoice: "AUTO",
      });
      (this as any).diagnostics?.checkpoint?.("SEMANTIC_TURN_GATE_V29_ENABLED", {
        vad_can_arm_tool_gate: false,
        transcript_required_to_arm: true,
        vad_can_create_normal_response: false,
        transcript_owns_normal_response_creation: true,
        ignored_input_tool: INPUT_IGNORED,
        presence_authority: "ConversationTurnLifecycle",
        semantic_state_owner: "semantic_turn_runtime",
        single_public_tool_per_caller_turn: true,
        provider_command_boundary: "realtime_command_port",
        tool_authorization_boundary: "semantic_tool_authorization_port",
      });
    }
    return response;
  }

  private debugEnabledV29(): boolean {
    return Boolean((this as any).diagnostics?.snapshot?.().enabled);
  }

  private installObservabilityV29(): void {
    if (this.observabilityInstalledV29) return;
    this.observabilityInstalledV29 = true;
    installRealtimeToolResultObserver(this as any, (request) => {
      if (!this.debugEnabledV29()) return;
      const output = typeof request.output === "string"
        ? request.output.slice(0, 2000)
        : JSON.stringify(request.output ?? {}).slice(0, 2000);
      (this as any).diagnostics?.checkpoint?.("DEBUG_TOOL_OUTPUT_V29", {
        call_id: request.callId ?? null,
        tool: request.toolName ?? null,
        output,
      });
    });
  }

  private handleIgnoredInputV29(event: SemanticToolEventV29): void {
    let reason = "UNCERTAIN";
    try {
      const args = event.arguments?.trim() ? JSON.parse(event.arguments) as Record<string, unknown> : {};
      if (typeof args.reason === "string" && args.reason.trim()) reason = args.reason.trim();
    } catch { /* fail safe */ }
    (this as any).diagnostics?.checkpoint?.("BACKGROUND_INPUT_IGNORED_V29", {
      reason,
      no_business_action: true,
      no_spoken_response: true,
      lifecycle_authority: true,
      provider_command_boundary: "realtime_command_port",
    });
    realtimeCommandPortFor(this as any).submitToolResult({
      callId: event.call_id,
      toolName: INPUT_IGNORED,
      output: { ok: true, status: "IGNORED", reason, speak: false, mutation: false },
    });
    semanticTurnRuntimeFor(this).clearItemAuthority();
    conversationLifecyclePortFor(this).semanticIgnored(reason);
  }

  private authorizeToolV29(event: SemanticToolEventV29): boolean {
    if (this.debugEnabledV29() && event.name) {
      (this as any).diagnostics?.checkpoint?.("DEBUG_MODEL_TOOL_DECISION_V29", {
        tool: event.name,
        arguments: (event.arguments ?? "{}").slice(0, 2000),
        call_id: event.call_id ?? null,
      });
    }
    const result = publicRestaurantToolAuthorizationPortFor(this).decide(event);
    if (result.directedIgnoreRejected) {
      realtimeCommandPortFor(this as any).createDefaultResponse();
      return false;
    }
    if (result.ignored) {
      this.handleIgnoredInputV29(event);
      return false;
    }
    return result.allowed;
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const events = adaptRealtimeProviderEvents(data);
    let requestTranscriptAuthorizedResponse = false;
    let transcriptResponseItemId: string | null = null;
    let provisionalIgnoreSupersededForResponse = false;

    const speechStarted = events.find((event) => event.type === "CALLER_SPEECH_STARTED");
    if (speechStarted?.type === "CALLER_SPEECH_STARTED") {
      const itemId = typeof speechStarted.itemId === "string" ? speechStarted.itemId : null;
      beginSemanticTurnFromAcousticEvidence(this, { itemId, source: "v29_provider_event_adapter" });
      await V26Prototype.handleRealtimeMessage.call(this, data);
      return;
    }

    const transcriptEvent = events.find((event) => event.type === "CALLER_TRANSCRIPT_COMPLETED");
    if (transcriptEvent?.type === "CALLER_TRANSCRIPT_COMPLETED") {
      const transcript = usableTranscript(transcriptEvent.transcript);
      if (this.debugEnabledV29()) {
        (this as any).diagnostics?.checkpoint?.("DEBUG_USER_TRANSCRIPT_V29", {
          transcript: transcript ?? "",
          usable: transcript !== null,
        });
      }
      if (transcript) {
        if (isPureGreetingTurn(transcript)) {
          semanticTurnRuntimeFor(this).clearItemAuthority();
          realtimeCommandPortFor(this as any).speak({
            isolated: true,
            tools: "DISABLED",
            purpose: "pure_greeting_v29",
            exactText: PURE_GREETING_REPLY,
            instructions: `Pronuncia exactamente esta frase y nada más: ${JSON.stringify(PURE_GREETING_REPLY)}`,
            metadata: {
              authority: "conversational_turn_policy",
              backend_tool_authority: false,
              contextual_close_question: false,
            },
          });
          (this as any).diagnostics?.checkpoint?.("PURE_GREETING_HANDLED_V29", {
            backend_tool_authority: false,
            response: "DETERMINISTIC_GREETING",
            contextual_close_question: false,
            semantic_gate_armed: false,
          });
          return;
        }
        const itemId = typeof transcriptEvent.itemId === "string" ? transcriptEvent.itemId : null;
        const higherLayerOwns = turnOwnershipRuntimeFor(this).ownsSemanticItem(itemId);
        const runtime = semanticTurnRuntimeFor(this);
        const provisionalIgnoreSuperseded = runtime.shouldReopenAfterProvisionalIgnore(INPUT_IGNORED);
        const beginFreshSemanticTurn = provisionalIgnoreSuperseded || runtime.shouldBeginForTranscript(higherLayerOwns);
        if (beginFreshSemanticTurn) {
          runtime.beginFreshTurn();
          if (provisionalIgnoreSuperseded) {
            (this as any).diagnostics?.checkpoint?.("PROVISIONAL_BACKGROUND_IGNORE_SUPERSEDED_V29", {
              item_id: itemId,
              previous_tool: INPUT_IGNORED,
              authority: "usable_completed_transcript",
              semantic_turn_reopened: true,
            });
          } else if (higherLayerOwns) {
            (this as any).diagnostics?.checkpoint?.("CONFIRMED_BARGE_IN_SEMANTIC_TURN_STARTED_V29", {
              item_id: itemId,
              authority: "turn_ownership_runtime",
              previous_turn_decision_discarded: true,
            });
          }
        }
        if (itemId && higherLayerOwns) {
          armCallerDirectedSemanticAuthority(this, itemId, "turn_ownership_runtime");
        }
        if (runtime.shouldArmGateAfterTranscript()) {
          armSemanticGate(this, transcript, itemId);
          if (!higherLayerOwns) {
            requestTranscriptAuthorizedResponse = true;
            transcriptResponseItemId = itemId;
            provisionalIgnoreSupersededForResponse = provisionalIgnoreSuperseded;
          }
        } else {
          (this as any).diagnostics?.checkpoint?.("SEMANTIC_GATE_LATE_TRANSCRIPT_BYPASSED_V29", {
            item_id: itemId,
            authoritative_tool: runtime.snapshot().selectedTool,
            reason: "tool_already_selected_for_caller_turn",
          });
        }
      }
    }

    const toolEvent = events.find(
      (event) => event.type === "SEMANTIC_TOOL_SELECTED" && isPublicRestaurantTool(event.name),
    );
    if (toolEvent?.type === "SEMANTIC_TOOL_SELECTED" && isPublicRestaurantTool(toolEvent.name)) {
      const semanticEvent: SemanticToolEventV29 = {
        name: toolEvent.name,
        call_id: toolEvent.callId,
        arguments: toolEvent.arguments,
      };
      if (!this.authorizeToolV29(semanticEvent)) return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);

    if (requestTranscriptAuthorizedResponse) {
      if (realtimeAssistantResponseActiveFor(this as any)) {
        (this as any).diagnostics?.checkpoint?.("TRANSCRIPT_AUTHORIZED_RESPONSE_SUPPRESSED_V29", {
          item_id: transcriptResponseItemId,
          authority: "runtime_active_response_owner",
          response_requested: false,
          duplicate_response_prevented: true,
          timer_used: false,
        });
        return;
      }

      realtimeCommandPortFor(this as any).createDefaultResponse();
      (this as any).diagnostics?.checkpoint?.("TRANSCRIPT_AUTHORIZED_RESPONSE_REQUESTED_V29", {
        item_id: transcriptResponseItemId,
        authority: "usable_completed_transcript",
        response_requested: true,
        semantic_gate_required: true,
        higher_layer_response_owner: false,
        timer_used: false,
      });
      if (provisionalIgnoreSupersededForResponse) {
        (this as any).diagnostics?.checkpoint?.("PROVISIONAL_BACKGROUND_IGNORE_RETRY_REQUESTED_V29", {
          item_id: transcriptResponseItemId,
          response_requested: true,
          timer_used: false,
          semantic_gate_required: true,
        });
      }
    }
  }
}
