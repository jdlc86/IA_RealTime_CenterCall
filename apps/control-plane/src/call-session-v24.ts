import { CallSession as CallSessionV23 } from "./call-session-v23";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";
import { marketingConsentPortFor } from "./marketing-consent-port.js";

const BaseConstructor = CallSessionV23 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV23.prototype as any;
const MARKETING = "restaurant_marketing_preferences";
const CONSENT_TEXT_VERSION = "voice-promotions-v1";

type MarketingAction = "QUERY" | "GRANT" | "DECLINE" | "REVOKE";

function parseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be a JSON object");
  return parsed as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function parseAction(value: unknown): MarketingAction {
  if (value !== "QUERY" && value !== "GRANT" && value !== "DECLINE" && value !== "REVOKE") {
    throw new Error("Invalid marketing action");
  }
  return value;
}

/**
 * v24 completes the agent+tools migration for the public Lucia tool surface.
 * Marketing no longer routes through synthetic conversation_intent/CoreIntent.
 * Caller ID remains the only supported identity for preference reads/writes.
 */
export class CallSession extends BaseConstructor {
  private sendOutputV24(callId: string | undefined, output: Record<string, unknown>): void {
    const port = realtimeCommandPortFor(this as any);
    port.submitToolResult({ callId, toolName: MARKETING, output });
    port.createDefaultResponse();
  }

  private markDirectMarketingV24(): void {
    const lifecycle = conversationLifecyclePortFor(this);
    lifecycle.validateUserTurn("agent_tool");
    lifecycle.suspendForTool(MARKETING);
    (this as any).diagnostics?.checkpoint?.("LUCIA_AGENT_TOOL_SELECTED", {
      tool: MARKETING,
      compatibility_executor: "direct_marketing_controller_v24",
    });
  }

  private async executeMarketingV24(callId: string | undefined, args: Record<string, unknown>): Promise<void> {
    const tenantId = requireString((this as any).tenantId, "tenant_id");
    const callerPhone = requireString((this as any).callerPhone, "caller_phone");
    const runtimeCallId = requireString((this as any).callId, "call_id");
    const action = parseAction(args.action);
    const explicit = args.explicit === true;
    const store = marketingConsentPortFor(this);

    if (action === "QUERY") {
      if (explicit) throw new Error("QUERY must use explicit=false");
      const status = await store.getLatestStatus(tenantId, callerPhone);
      (this as any).diagnostics?.checkpoint?.("DIRECT_MARKETING_QUERY_COMPLETED_V24", {
        status: status ?? "NO_RECORD",
        identity_source: "CALLER_ID",
        changed: false,
      });
      this.sendOutputV24(callId, {
        ok: true,
        status: "MARKETING_STATUS",
        preference_status: status ?? "NO_RECORD",
        changed: false,
        identity_source: "CALLER_ID",
      });
      return;
    }

    if (!explicit) {
      this.sendOutputV24(callId, {
        ok: true,
        status: "EXPLICIT_DECISION_REQUIRED",
        action,
        changed: false,
        instruction: "No modifiques preferencias. Pide una decisión explícita del usuario y vuelve a llamar a la tool.",
      });
      return;
    }

    const event = await store.record(tenantId, {
      action,
      phone: callerPhone,
      callerPhone,
      callId: runtimeCallId,
      consentTextVersion: CONSENT_TEXT_VERSION,
      verificationMethod: "CALLER_ID_MATCH",
    });

    (this as any).diagnostics?.checkpoint?.("DIRECT_MARKETING_PREFERENCE_CHANGED_V24", {
      action,
      resulting_status: event.status,
      identity_source: "CALLER_ID",
      consent_text_version: CONSENT_TEXT_VERSION,
    });
    this.sendOutputV24(callId, {
      ok: true,
      status: "MARKETING_UPDATED",
      action,
      preference_status: event.status,
      changed: true,
      identity_source: "CALLER_ID",
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = adaptRealtimeProviderEvents(data).find(
      (candidate) => candidate.type === "SEMANTIC_TOOL_SELECTED" && candidate.name === MARKETING,
    );

    if (event?.type === "SEMANTIC_TOOL_SELECTED" && event.name === MARKETING) {
      let args: Record<string, unknown>;
      try {
        args = parseObject(event.arguments);
      } catch (error) {
        this.sendOutputV24(event.callId, {
          ok: false,
          status: "ERROR",
          error: "INVALID_ARGUMENTS",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      this.markDirectMarketingV24();
      try {
        await this.executeMarketingV24(event.callId, args);
      } catch (error) {
        (this as any).diagnostics?.fail?.("DIRECT_MARKETING_TOOL_FAILED_V24", "DIRECT_MARKETING_EXECUTION_FAILED", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.sendOutputV24(event.callId, {
          ok: false,
          status: "ERROR",
          error: "EXECUTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
