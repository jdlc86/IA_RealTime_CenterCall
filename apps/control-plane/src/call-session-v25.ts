import { CallSession as CallSessionV24 } from "./call-session-v24";
import { authorizePublicRestaurantTool, isPublicRestaurantTool } from "./public-tool-authorization";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";

const BaseConstructor = CallSessionV24 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV24.prototype as any;

function parseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be a JSON object");
  return parsed as Record<string, unknown>;
}

/**
 * v25 is the single authorization boundary for Lucia's public tool surface.
 * No public tool may reach a direct controller unless tenant capability policy
 * authorizes it. Runtime-only safety tools (end_call/out_of_scope) remain built-in.
 */
export class CallSession extends BaseConstructor {
  private sendAuthorizationFailureV25(callId: string | undefined, tool: string, requiredCapabilities: string[]): void {
    const port = realtimeCommandPortFor(this as any);
    port.submitToolResult({
      callId,
      toolName: tool,
      output: {
        ok: false,
        status: "ERROR",
        error: "TOOL_NOT_ALLOWED",
        tool,
        required_capabilities: requiredCapabilities,
        retryable: false,
      },
    });
    port.createDefaultResponse();
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = adaptRealtimeProviderEvents(data).find(
      (candidate) => candidate.type === "SEMANTIC_TOOL_SELECTED" && isPublicRestaurantTool(candidate.name),
    );

    if (event?.type === "SEMANTIC_TOOL_SELECTED" && isPublicRestaurantTool(event.name)) {
      let args: Record<string, unknown>;
      try {
        args = parseObject(event.arguments);
      } catch (error) {
        (this as any).diagnostics?.fail?.("PUBLIC_TOOL_AUTHORIZATION_INVALID_ARGUMENTS_V25", "INVALID_AGENT_TOOL_ARGUMENTS", {
          tool: event.name,
          error: error instanceof Error ? error.message : String(error),
        });
        const port = realtimeCommandPortFor(this as any);
        port.submitToolResult({
          callId: event.callId,
          toolName: event.name,
          output: { ok: false, status: "ERROR", error: "INVALID_ARGUMENTS", retryable: false },
        });
        port.createDefaultResponse();
        return;
      }

      const configuredAllowedTools = Array.isArray((this as any).allowedTools)
        ? (this as any).allowedTools.filter((value: unknown): value is string => typeof value === "string")
        : [];
      const decision = authorizePublicRestaurantTool(event.name, args, configuredAllowedTools);

      (this as any).diagnostics?.checkpoint?.("PUBLIC_TOOL_AUTHORIZATION_EVALUATED_V25", {
        tool: event.name,
        allowed: decision.allowed,
        reason: decision.reason,
        matched_capability: decision.matchedCapability,
        required_capabilities: decision.requiredCapabilities,
      });

      if (!decision.allowed) {
        (this as any).diagnostics?.fail?.("PUBLIC_TOOL_AUTHORIZATION_BLOCKED_V25", "TOOL_NOT_ALLOWED", {
          tool: event.name,
          required_capabilities: decision.requiredCapabilities,
          configured_allowed_tools: configuredAllowedTools,
        });
        this.sendAuthorizationFailureV25(event.callId, event.name, decision.requiredCapabilities);
        return;
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
