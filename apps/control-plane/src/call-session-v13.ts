import { CallSession as CallSessionV12 } from "./call-session-v12";
import {
  initialCoreIntentState,
  returnFromAuxiliaryBusinessInfo,
  transitionCoreIntent,
  type BusinessInfoTopic,
  type CoreIntentState,
  type CoreWorkflow,
} from "./core-intent-machine";
import { decideClosingTransition } from "./core-closing-policy";
import { adaptHierarchicalIntentToLegacy } from "./core-intent-legacy-adapter";
import { coreIntentClassifierTool, parseCoreIntentRequest } from "./core-intent-router";
import type { ToolResult } from "./tool-gateway";
import { claimClassifierBootstrap, ownsClassifierBootstrap } from "./classifier-bootstrap-authority.js";
import { conversationNextActionRuntimeFor } from "./conversation-next-action-runtime.js";

const CONVERSATION_INTENT = "conversation_intent";
const BaseConstructor = CallSessionV12 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV12.prototype as any;

type RealtimeEvent = { type?: string; name?: string; call_id?: string; arguments?: string; };

type TopicResult = {
  topic: BusinessInfoTopic;
  ok: boolean;
  result?: unknown;
  error?: string;
};

const TOOL_BY_TOPIC: Record<BusinessInfoTopic, string> = {
  MENU: "get_menu",
  HOURS: "get_business_hours",
  LOCATION: "get_business_information",
  SERVICES: "get_services",
  GENERAL_INFO: "get_business_information",
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function currentMadridReference(): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    dateStyle: "full",
    timeStyle: "long",
  }).format(new Date());
}

function requireRuntimeString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing runtime configuration: ${name}`);
  return value.trim();
}

/**
 * v13 owns the top-level structured conversation state. Lucia provides semantic
 * intent + next conversational action every relevant turn; backend executors stay
 * authoritative for business facts and mutations.
 */
export class CallSession extends BaseConstructor {
  private coreIntentStateV13: CoreIntentState = initialCoreIntentState();
  private coreIntentSessionUpdateV13Sent = false;
  private closingConfirmationPendingV13 = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    if (isStart) claimClassifierBootstrap(this, "CORE_INTENT_V13");

    const response = await super.fetch(request);

    if (isStart && response.ok && ownsClassifierBootstrap(this, "CORE_INTENT_V13") && !this.coreIntentSessionUpdateV13Sent) {
      this.coreIntentSessionUpdateV13Sent = true;
      (this as any).send({
        type: "session.update",
        session: {
          type: "realtime",
          tools: [coreIntentClassifierTool(currentMadridReference())],
          tool_choice: "required",
        },
      });
      (this as any).diagnostics?.checkpoint?.("CORE_INTENT_CLASSIFIER_SCHEMA_UPDATED", {
        strategy: "structured_conversation_state_v2",
        classifier_count: 1,
        business_info_multi_topic: true,
        legacy_executor_adapter: true,
        structured_next_action_required: true,
        structured_closing_signal_required: true,
      });
    }

    return response;
  }

  private sendCoreClassifierOutput(callId: string | undefined, payload: Record<string, unknown>): void {
    if (!callId) return;
    (this as any).send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ ok: true, ...payload }),
      },
    });
  }

  private clearTransientStateForWorkflow(workflow: CoreWorkflow): void {
    if (workflow === "CREATE_RESERVATION") {
      (this as any).reservationDraft = {};
      (this as any).reservationAvailabilityKey = null;
      (this as any).reservationAvailabilityPromise = null;
      (this as any).reservationConfirmationFingerprint = null;
      (this as any).createReservationIntentActiveV9 = false;
      return;
    }
    if (workflow === "CANCEL_RESERVATION") {
      (this as any).cancellationStateV10 = null;
    }
  }

  private applyWorkflowTransitionCleanup(previous: CoreIntentState, next: CoreIntentState, reason: string): void {
    if (reason === "AUXILIARY_INFO_ENTER" || reason === "CONTINUE_CURRENT") return;
    if (previous.workflow === next.workflow) return;
    this.clearTransientStateForWorkflow(previous.workflow);
  }

  private async executeBusinessInfoTopics(topics: BusinessInfoTopic[]): Promise<TopicResult[]> {
    const tenantId = requireRuntimeString((this as any).tenantId, "tenant_id");
    const callId = requireRuntimeString((this as any).callId, "call_id");
    const gateway = (this as any).createToolGateway();

    const toolPromises = new Map<string, Promise<ToolResult>>();
    for (const topic of topics) {
      const tool = TOOL_BY_TOPIC[topic];
      if (!toolPromises.has(tool)) {
        toolPromises.set(tool, gateway.execute({ name: tool, arguments: {}, context: { tenantId, callId } }) as Promise<ToolResult>);
      }
    }

    const toolResults = new Map<string, ToolResult>();
    await Promise.all([...toolPromises.entries()].map(async ([tool, promise]) => {
      try {
        toolResults.set(tool, await promise);
      } catch (error) {
        toolResults.set(tool, {
          ok: false,
          tool,
          tenantId,
          error: "EXECUTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        } as ToolResult);
      }
    }));

    return topics.map((topic) => {
      const result = toolResults.get(TOOL_BY_TOPIC[topic]);
      if (!result || !result.ok) {
        return { topic, ok: false, error: result && !result.ok ? result.error : "NO_RESULT" };
      }
      return { topic, ok: true, result: result.result };
    });
  }

  private async handleBusinessInfoTurn(callId: string | undefined, topics: BusinessInfoTopic[], auxiliary: boolean): Promise<void> {
    (this as any).state = "active";
    (this as any).ambiguousCount = 0;
    (this as any).diagnostics?.checkpoint?.("BUSINESS_INFO_MULTI_TOPIC_STARTED", {
      topics,
      topic_count: topics.length,
      auxiliary,
    });

    const results = await this.executeBusinessInfoTopics(topics);
    const successful = results.filter((entry) => entry.ok).length;
    (this as any).diagnostics?.checkpoint?.("BUSINESS_INFO_MULTI_TOPIC_COMPLETED", {
      topics,
      topic_count: topics.length,
      successful_count: successful,
      failed_count: results.length - successful,
      execution: "parallel_by_unique_tool",
    });

    this.sendCoreClassifierOutput(callId, {
      action: "business_info_completed",
      topics,
      successful_count: successful,
      failed_count: results.length - successful,
    });

    const suspended = this.coreIntentStateV13.suspendedWorkflow;
    const resumeInstruction = auxiliary && suspended
      ? ` Después de responder a esta consulta, retoma brevemente el workflow ${suspended} desde el punto ya conocido. No repitas datos ya recogidos, no reinicies el workflow y no inventes ningún estado empresarial.`
      : "";

    (this as any).createSpokenResponse(
      `Responde en una sola intervención usando exclusivamente estos resultados autorizados por topic: ${JSON.stringify(results)}. Contesta todos los topics solicitados que tengan resultado. Si un topic no tiene dato verificado, indícalo brevemente. No menciones herramientas, JSON ni procesos internos.${resumeInstruction}`,
    );

    if (auxiliary && this.coreIntentStateV13.suspendedWorkflow) {
      const returned = returnFromAuxiliaryBusinessInfo(this.coreIntentStateV13);
      this.coreIntentStateV13 = returned.next;
      (this as any).diagnostics?.checkpoint?.("CORE_INTENT_TRANSITION", {
        from: returned.previous.workflow,
        to: returned.next.workflow,
        reason: returned.reason,
      });
    }
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "response.function_call_arguments.done" && event.name === CONVERSATION_INTENT) {
      const nextAction = conversationNextActionRuntimeFor(this);
      if ((this as any).state === "closing" || (this as any).hangupStarted === true) {
        await BasePrototype.handleRealtimeMessage.call(this, data);
        return;
      }

      let request;
      try {
        request = parseCoreIntentRequest(event.arguments);
      } catch (error) {
        this.sendCoreClassifierOutput(event.call_id, { action: "classifier_invalid", retry: true });
        (this as any).diagnostics?.fail?.("CORE_INTENT_TURN_INVALID", "HIERARCHICAL_CLASSIFIER_PAYLOAD_INVALID", {
          error: error instanceof Error ? error.message : String(error),
        });
        (this as any).createSpokenResponse("No inventes una intención ni una acción. Pide al usuario de forma breve que aclare qué necesita.");
        return;
      }

      nextAction.update(request.conversation?.nextAction ?? "CONTINUE_WORKFLOW");
      const closingSignal = request.conversation?.closingSignal ?? "NONE";
      (this as any).diagnostics?.checkpoint?.("CORE_STRUCTURED_CONVERSATION_STATE", {
        intent: request.intent,
        next_action: nextAction.current(),
        closing_signal: closingSignal,
        workflow_before: this.coreIntentStateV13.workflow,
        closing_pending_before: this.closingConfirmationPendingV13,
      });

      const rejectedClosing = request.closingResponse === "REJECT" || closingSignal === "REJECTED";
      if (this.closingConfirmationPendingV13 && rejectedClosing) {
        this.closingConfirmationPendingV13 = false;
        nextAction.update("CONTINUE_WORKFLOW");
        (this as any).state = "active";
        (this as any).ambiguousCount = 0;
        const currentWorkflow = this.coreIntentStateV13.workflow;
        const pureRejection = request.intent === "CLOSING"
          || request.intent === currentWorkflow
          || (currentWorkflow === "ROUTING"
            && request.intent === "BUSINESS_INFO"
            && request.businessInfoTopics?.length === 1
            && request.businessInfoTopics[0] === "GENERAL_INFO");

        this.sendCoreClassifierOutput(event.call_id, {
          action: "closing_rejected",
          resumed_workflow: currentWorkflow,
          has_new_intent: !pureRejection,
        });
        (this as any).diagnostics?.checkpoint?.("CORE_CLOSING_REJECTED_RESUMED", {
          resumed_workflow: currentWorkflow,
          state_preserved: true,
          has_new_intent: !pureRejection,
        });

        if (pureRejection) {
          (this as any).createSpokenResponse(
            currentWorkflow === "ROUTING"
              ? "Responde brevemente: De acuerdo. ¿Necesitas algo más en lo que pueda ayudarte?"
              : `El usuario ha rechazado terminar la llamada. No cierres la llamada ni reinicies nada. Retoma el workflow ${currentWorkflow} exactamente desde el punto anterior, conservando todos los datos ya recogidos. Si ese workflow ya estaba completado, pregunta brevemente: ¿Necesitas algo más en lo que pueda ayudarte?`,
          );
          return;
        }
      }

      const explicitStructuredClose = request.intent === "CLOSING"
        && closingSignal === "CONFIRMED"
        && nextAction.current() === "HANGUP_AFTER_SPEECH";
      const requestedIntent = (this.closingConfirmationPendingV13 && request.closingResponse === "CONFIRM") || explicitStructuredClose
        ? "CLOSING"
        : request.intent;
      const closingDecision = decideClosingTransition(
        this.coreIntentStateV13.workflow,
        requestedIntent,
        this.closingConfirmationPendingV13,
        explicitStructuredClose,
      );
      this.closingConfirmationPendingV13 = closingDecision.pending;

      if (closingDecision.action === "ASK_CONFIRMATION") {
        nextAction.update("ASK_CLOSE_CONFIRMATION");
        this.sendCoreClassifierOutput(event.call_id, { action: "closing_confirmation_required" });
        (this as any).diagnostics?.checkpoint?.("CORE_CLOSING_CONFIRMATION_REQUIRED", {
          active_workflow: this.coreIntentStateV13.workflow,
          irreversible_transition: true,
          structured_next_action: nextAction.current(),
        });
        (this as any).createSpokenResponse("Pregunta únicamente y de forma breve: ¿Quieres terminar la llamada? No te despidas, no afirmes que la llamada ha terminado y no abandones el workflow actual todavía.");
        return;
      }

      if (closingDecision.action === "ALLOW_CLOSE") {
        nextAction.update("HANGUP_AFTER_SPEECH");
      }

      const effectiveRequest = requestedIntent === request.intent ? request : { ...request, intent: requestedIntent };
      const transition = transitionCoreIntent(this.coreIntentStateV13, effectiveRequest);
      this.applyWorkflowTransitionCleanup(transition.previous, transition.next, transition.reason);
      this.coreIntentStateV13 = transition.next;
      (this as any).diagnostics?.checkpoint?.("CORE_INTENT_TRANSITION", {
        from: transition.previous.workflow,
        to: transition.next.workflow,
        reason: transition.reason,
        business_info_topics: transition.next.businessInfoTopics,
        suspended_workflow: transition.next.suspendedWorkflow,
        structured_next_action: nextAction.current(),
      });

      if (effectiveRequest.intent === "BUSINESS_INFO") {
        await this.handleBusinessInfoTurn(event.call_id, transition.next.businessInfoTopics, effectiveRequest.auxiliary === true);
        return;
      }

      const legacyArguments = requestedIntent === request.intent
        ? event.arguments
        : JSON.stringify({ ...(event.arguments ? JSON.parse(event.arguments) : {}), intent: requestedIntent });
      const legacy = adaptHierarchicalIntentToLegacy(legacyArguments);
      if (!legacy) {
        this.sendCoreClassifierOutput(event.call_id, { action: "no_legacy_route" });
        return;
      }

      const synthetic: RealtimeEvent = {
        ...event,
        name: CONVERSATION_INTENT,
        arguments: JSON.stringify(legacy),
      };
      (this as any).diagnostics?.checkpoint?.("CORE_INTENT_EXECUTOR_DISPATCHED", {
        workflow: transition.next.workflow,
        adapter: "validated_legacy_executor",
        structured_next_action: nextAction.current(),
      });
      await BasePrototype.handleRealtimeMessage.call(this, JSON.stringify(synthetic));
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
