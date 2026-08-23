import { CallSession as CallSessionV16 } from "./call-session-v16";
import {
  adaptRealtimeProviderEvents,
  realtimeCommandPortFor,
} from "./realtime-provider-runtime.js";
import { recordCallerSecuritySignalDurably } from "./caller-security-signal-delivery.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import {
  RESTAURANT_SECURITY_BOUNDARY_TOOL,
  SEMANTIC_SECURITY_POLICY,
  parseSemanticSecurityIncident,
} from "./semantic-security-boundary.js";
import {
  DIRECT_AGENT_TOOL_NAMES,
  directAgentRealtimeBootstrapPolicy,
} from "./direct-agent-realtime-bootstrap.js";

const BaseConstructor = CallSessionV16 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV16.prototype as any;

export class CallSession extends BaseConstructor {
  private agentToolsInstalledV17 = false;

  async fetch(request: Request): Promise<Response> {
    const isStart = request.method === "POST" && new URL(request.url).pathname === "/start";
    const response = await super.fetch(request);
    if (isStart && response.ok && !this.agentToolsInstalledV17) {
      this.agentToolsInstalledV17 = true;
      const bootstrap = directAgentRealtimeBootstrapPolicy(this as any);
      realtimeCommandPortFor(this as any).updateSessionPolicy({
        ...bootstrap,
        toolChoice: "AUTO",
      });
      (this as any).diagnostics?.checkpoint?.("LUCIA_DIRECT_TOOLS_V17_ENABLED", {
        architecture: "agent_tools_mcp_pattern",
        tool_count: bootstrap.tools.length,
        mandatory_classifier: false,
        legacy_agent_bridge_enabled: false,
        tool_choice: "auto",
        backend_authority_preserved: true,
        provider_command_port: true,
        shared_bootstrap_policy: true,
      });
    }
    return response;
  }

  private async handleSemanticSecurityIncidentV17(toolEvent: { callId?: string; arguments?: string }): Promise<void> {
    const incident = parseSemanticSecurityIncident(toolEvent.arguments);
    const category = incident?.category ?? "UNCLASSIFIED_SECURITY_THREAT";
    const tenantId = (this as any).tenantId;
    const callerPhone = (this as any).callerPhone;

    const realtime = realtimeCommandPortFor(this as any);
    realtime.submitToolResult({
      callId: toolEvent.callId,
      toolName: RESTAURANT_SECURITY_BOUNDARY_TOOL,
      output: {
        ok: true,
        status: "SECURITY_BOUNDARY_ENFORCED",
        category,
        confidential_content_disclosed: false,
        mutation: false,
      },
    });
    conversationLifecyclePortFor(this).confirmEndCall(
      "semantic_security_high_confidence_v17",
      "semantic_security_boundary_v17",
    );

    if (typeof tenantId === "string" && tenantId.trim() && typeof callerPhone === "string" && callerPhone.trim()) {
      try {
        const result = await recordCallerSecuritySignalDurably(this, {
          tenantId: tenantId.trim(),
          callerPhone: callerPhone.trim(),
          eventType: `SEMANTIC_${category}`,
          severity: "HIGH",
          riskDelta: 5,
          highConfidence: true,
          metadata: {
            semantic_security_boundary: true,
            raw_transcript_stored: false,
            model_arguments_stored: false,
          },
        });
        (this as any).diagnostics?.checkpoint?.("SEMANTIC_SECURITY_SIGNAL_RECORDED_V17", {
          category,
          delivery: result.delivery,
          action: result.decision?.action ?? "PENDING_RETRY",
        });
      } catch (error) {
        (this as any).diagnostics?.fail?.("SEMANTIC_SECURITY_SIGNAL_RECORD_FAILED_V17", "CYBERSECURITY_STORE_FAILED", {
          category,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    (this as any).diagnostics?.checkpoint?.("SEMANTIC_SECURITY_BOUNDARY_ENFORCED_V17", {
      category,
      raw_transcript_stored: false,
      model_arguments_stored: false,
      call_terminated: true,
      lifecycle_authority: "conversation_lifecycle_port",
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const toolEvent = adaptRealtimeProviderEvents(data).find(
      (event) => event.type === "SEMANTIC_TOOL_SELECTED" && DIRECT_AGENT_TOOL_NAMES.has(event.name),
    );
    if (toolEvent?.type === "SEMANTIC_TOOL_SELECTED") {
      if (toolEvent.name === RESTAURANT_SECURITY_BOUNDARY_TOOL) {
        await this.handleSemanticSecurityIncidentV17({ callId: toolEvent.callId, arguments: toolEvent.arguments });
        return;
      }
      if (toolEvent.name === "restaurant_conversation") {
        const realtime = realtimeCommandPortFor(this as any);
        realtime.submitToolResult({
          callId: toolEvent.callId,
          toolName: toolEvent.name,
          output: {
            ok: true,
            status: "CONVERSATION",
            mutation: false,
            instruction: `${SEMANTIC_SECURITY_POLICY} Responde ahora al último turno del usuario de forma breve, natural y coherente con todo el contexto. No inventes datos del restaurante ni conviertas este intercambio conversacional en una operación, una transferencia o un cierre.`,
          },
        });
        realtime.createDefaultResponse();
        (this as any).diagnostics?.checkpoint?.("NATURAL_CONVERSATION_TURN_ACCEPTED_V17", {
          model_owned_interpretation: true,
          mutation: false,
          deterministic_phrase_matching: false,
        });
        return;
      }
      (this as any).diagnostics?.fail?.("UNHANDLED_PUBLIC_AGENT_TOOL", "DIRECT_TOOL_CONTROLLER_MISSING", {
        tool: toolEvent.name,
        legacy_fallback: false,
      });
      const realtime = realtimeCommandPortFor(this as any);
      realtime.submitToolResult({
        callId: toolEvent.callId,
        toolName: toolEvent.name,
        output: { ok: false, status: "ERROR", error: "DIRECT_TOOL_CONTROLLER_MISSING", retryable: false },
      });
      realtime.createDefaultResponse();
      return;
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
