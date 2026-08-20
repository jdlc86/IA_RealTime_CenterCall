import { CallSession as CallSessionV42 } from "./call-session-v42-turn-boundaries";
import {
  authorizeHumanHandoff,
  clearHumanHandoffOfferForCompetingAction,
  initialHumanHandoffAuthorizationState,
  isExplicitHumanHandoffRejection,
  observeHumanHandoffCallerTurn,
  type HumanHandoffAuthorizationState,
} from "./human-handoff-authorization-policy.js";
import { realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import { releaseSemanticGate } from "./semantic-turn-coordinator.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";

const BaseConstructor = CallSessionV42 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV42.prototype as any;
const HUMAN_ASSISTANCE = "restaurant_human_assistance";
const INPUT_IGNORED = "restaurant_input_ignored";

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  transcript?: unknown;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
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
  return normalized ? normalized.slice(0, 1500) : null;
}

/**
 * v43 separates semantic recommendation from irreversible handoff authority.
 *
 * Lucia may decide that human assistance would be useful, but the runtime only
 * permits the terminal transport when the current caller turn explicitly
 * requests a human or explicitly accepts a transfer that was previously
 * offered. Model-only reasons such as SYSTEM_LIMITATION are not authority.
 */
export class CallSession extends BaseConstructor {
  private handoffAuthorizationV43: HumanHandoffAuthorizationState = initialHumanHandoffAuthorizationState();
  private latestCallerTranscriptV43: string | null = null;
  private explicitPendingOfferRejectionV43 = false;
  private handoffClarificationIssuedV43 = false;

  protected prepareHumanHandoffOfferFromBackendV26(context: {
    tool: string;
    backendReason: string;
    armOffer?: boolean;
  }): "OFFER_REQUIRED" | "CALLER_ALREADY_AUTHORIZED" {
    const existingAuthority = authorizeHumanHandoff(
      initialHumanHandoffAuthorizationState(),
      this.latestCallerTranscriptV43,
    );
    if (existingAuthority.allowed && existingAuthority.source === "EXPLICIT_REQUEST") {
      (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_BACKEND_REQUIREMENT_ALREADY_AUTHORIZED_V43", {
        source_tool: context.tool,
        backend_reason: context.backendReason,
        authorization_source: existingAuthority.source,
      });
      return "CALLER_ALREADY_AUTHORIZED";
    }

    if (context.armOffer === false) {
      (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_BACKEND_AUTHORITY_INSPECTED_V43", {
        source_tool: context.tool,
        backend_reason: context.backendReason,
        caller_already_authorized: false,
        offer_armed: false,
        transfer_started: false,
      });
      return "OFFER_REQUIRED";
    }

    this.handoffAuthorizationV43 = { offerPending: true };
    this.latestCallerTranscriptV43 = null;
    this.explicitPendingOfferRejectionV43 = false;
    this.handoffClarificationIssuedV43 = false;
    (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_OFFER_ARMED_FROM_BACKEND_V43", {
      source_tool: context.tool,
      backend_reason: context.backendReason,
      offer_pending: true,
      stale_caller_transcript_cleared: true,
      transfer_started: false,
    });
    return "OFFER_REQUIRED";
  }

  private emitHandoffToolOutputV43(event: RealtimeEvent, status: string, instruction: string): void {
    const session = this as any;
    releaseSemanticGate(this, HUMAN_ASSISTANCE);
    session.send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify({ ok: true, status, transfer_started: false, instruction }),
      },
    });
  }

  private rejectUnauthorizedHandoffV43(
    event: RealtimeEvent,
    source: "OFFER_REQUIRED" | "CALLER_REJECTED",
    offerWasAlreadyPending: boolean,
  ): void {
    const session = this as any;

    if (source === "CALLER_REJECTED") {
      this.handoffClarificationIssuedV43 = false;
      this.emitHandoffToolOutputV43(
        event,
        "HUMAN_HANDOFF_DECLINED",
        "No transfieras. El usuario no ha autorizado la transferencia. Continúa solo con las gestiones que puedas resolver.",
      );
      realtimeCommandPortFor(session).speak({
        instructions: "Confirma brevemente que no se realizará la transferencia y devuelve el turno al usuario. No llames herramientas en esta respuesta.",
        exactText: "De acuerdo, no te transfiero.",
        tools: "DISABLED",
        isolated: true,
        purpose: "human_handoff_declined_v43",
        metadata: {
          authority: "human_handoff_authorization_v43",
          authorization_source: source,
          tools_disabled: true,
        },
      });
    } else if (!offerWasAlreadyPending) {
      this.handoffClarificationIssuedV43 = false;
      this.emitHandoffToolOutputV43(
        event,
        "HUMAN_HANDOFF_CONFIRMATION_REQUIRED",
        "No transfieras todavía. Explica brevemente que esta gestión puede requerir una persona y pregunta si desea que le transfieras. Espera una respuesta explícita del usuario.",
      );
      realtimeCommandPortFor(session).speak({
        instructions: "Explica brevemente que esta gestión puede requerir una persona y pregunta una sola vez si desea que le transfieras. Espera una respuesta explícita del usuario. No llames herramientas en esta respuesta.",
        exactText: "Esta gestión puede requerir una persona. ¿Quieres que te transfiera?",
        tools: "DISABLED",
        isolated: true,
        purpose: "human_handoff_confirmation_v43",
        metadata: {
          authority: "human_handoff_authorization_v43",
          authorization_source: source,
          single_confirmation_prompt: true,
          tools_disabled: true,
        },
      });
    } else if (!this.handoffClarificationIssuedV43) {
      this.handoffClarificationIssuedV43 = true;
      this.emitHandoffToolOutputV43(
        event,
        "HUMAN_HANDOFF_CONFIRMATION_PENDING",
        "Ya existe una oferta de transferencia pendiente. No repitas la explicación. Pide únicamente una aclaración breve de sí o no y no llames herramientas.",
      );
      realtimeCommandPortFor(session).speak({
        instructions: "No repitas la explicación ni vuelvas a ofrecer la transferencia. Pide únicamente una aclaración breve de sí o no. No llames herramientas en esta respuesta.",
        exactText: "No he entendido si quieres que te transfiera. ¿Sí o no?",
        tools: "DISABLED",
        isolated: true,
        purpose: "human_handoff_confirmation_clarification_v43",
        metadata: {
          authority: "human_handoff_authorization_v43",
          authorization_source: source,
          duplicate_offer_suppressed: true,
          clarification_only: true,
          tools_disabled: true,
        },
      });
    } else {
      this.handoffAuthorizationV43 = { offerPending: false };
      this.handoffClarificationIssuedV43 = false;
      this.emitHandoffToolOutputV43(
        event,
        "HUMAN_HANDOFF_NOT_CONFIRMED",
        "No hay autorización suficiente para transferir. No repitas la oferta. Continúa sin transferencia.",
      );
      realtimeCommandPortFor(session).speak({
        instructions: "No repitas la oferta de transferencia. Indica brevemente que continuarás sin transferir y devuelve el turno al usuario. No llames herramientas.",
        exactText: "De acuerdo, seguimos sin transferirte. ¿En qué más puedo ayudarte?",
        tools: "DISABLED",
        isolated: true,
        purpose: "human_handoff_confirmation_abandoned_v43",
        metadata: {
          authority: "human_handoff_authorization_v43",
          authorization_source: source,
          duplicate_offer_suppressed: true,
          pending_offer_cleared: true,
          tools_disabled: true,
        },
      });
    }

    session.diagnostics?.checkpoint?.("HUMAN_HANDOFF_BLOCKED_WITHOUT_CALLER_AUTHORITY_V43", {
      authorization_source: source,
      transfer_started: false,
      caller_transcript_present: Boolean(this.latestCallerTranscriptV43),
      offer_pending: this.handoffAuthorizationV43.offerPending,
      offer_was_already_pending: offerWasAlreadyPending,
      clarification_issued: this.handoffClarificationIssuedV43,
      confirmation_response_tools_disabled: true,
    });
  }

  private consumeRejectedOfferMisclassifiedAsIgnoredV43(event: RealtimeEvent): boolean {
    if (event.type !== "response.function_call_arguments.done" || event.name !== INPUT_IGNORED || !this.explicitPendingOfferRejectionV43) return false;
    const session = this as any;
    this.explicitPendingOfferRejectionV43 = false;
    this.handoffAuthorizationV43 = { offerPending: false };
    this.handoffClarificationIssuedV43 = false;
    releaseSemanticGate(this, INPUT_IGNORED);
    conversationLifecyclePortFor(this).validateUserTurn("human_handoff_rejected");
    session.send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify({
          ok: true,
          status: "HUMAN_HANDOFF_DECLINED",
          transfer_started: false,
          speak: true,
          instruction: "La negativa del usuario responde a la oferta de transferencia; no es ruido. Confirma brevemente que no se transferirá y continúa disponible para ayudar con el restaurante.",
        }),
      },
    });
    realtimeCommandPortFor(session).speak({
      instructions: "Confirma brevemente que no se realizará la transferencia y continúa disponible para ayudar. No llames herramientas en esta respuesta.",
      exactText: "De acuerdo, no te transfiero. ¿En qué más puedo ayudarte?",
      tools: "DISABLED",
      isolated: true,
      purpose: "human_handoff_rejection_overruled_ignored_v43",
      metadata: {
        authority: "human_handoff_authorization_v43",
        pending_offer_cleared: true,
        tools_disabled: true,
      },
    });
    session.diagnostics?.checkpoint?.("HUMAN_HANDOFF_REJECTION_OVERRULED_IGNORED_INPUT_V43", {
      transfer_started: false,
      pending_offer_cleared: true,
      caller_presence_validated: true,
      model_tool: INPUT_IGNORED,
      lifecycle_owner: "conversation_lifecycle_port",
      semantic_gate_owner: "semantic_turn_coordinator",
    });
    return true;
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);

    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = usableTranscript(event.transcript);
      if (transcript) {
        this.explicitPendingOfferRejectionV43 = this.handoffAuthorizationV43.offerPending && isExplicitHumanHandoffRejection(transcript);
        this.handoffAuthorizationV43 = observeHumanHandoffCallerTurn(this.handoffAuthorizationV43, transcript);
        this.latestCallerTranscriptV43 = transcript;
      }
    }

    if (event && this.consumeRejectedOfferMisclassifiedAsIgnoredV43(event)) return;

    if (
      event?.type === "response.function_call_arguments.done" &&
      event.name &&
      event.name !== HUMAN_ASSISTANCE &&
      event.name !== INPUT_IGNORED &&
      this.handoffAuthorizationV43.offerPending
    ) {
      this.handoffAuthorizationV43 = clearHumanHandoffOfferForCompetingAction(this.handoffAuthorizationV43);
      this.handoffClarificationIssuedV43 = false;
      (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_PENDING_OFFER_CLEARED_BY_COMPETING_ACTION_V43", {
        selected_tool: event.name,
        pending_offer_cleared: true,
      });
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === HUMAN_ASSISTANCE) {
      const offerWasAlreadyPending = this.handoffAuthorizationV43.offerPending;
      const decision = authorizeHumanHandoff(this.handoffAuthorizationV43, this.latestCallerTranscriptV43);
      this.handoffAuthorizationV43 = decision.state;
      this.explicitPendingOfferRejectionV43 = false;

      if (!decision.allowed) {
        this.rejectUnauthorizedHandoffV43(event, decision.source, offerWasAlreadyPending);
        return;
      }

      this.handoffClarificationIssuedV43 = false;
      (this as any).diagnostics?.checkpoint?.("HUMAN_HANDOFF_AUTHORIZED_BY_CALLER_V43", {
        authorization_source: decision.source,
        caller_transcript_present: Boolean(this.latestCallerTranscriptV43),
      });
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
