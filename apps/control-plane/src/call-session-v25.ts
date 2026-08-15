import { CallSession as CallSessionV24 } from "./call-session-v24";
import { authorizePublicRestaurantTool, isPublicRestaurantTool } from "./public-tool-authorization";

const BaseConstructor = CallSessionV24 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV24.prototype as any;

type RealtimeEvent = { type?: string; name?: string; call_id?: string; arguments?: string };

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

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
    (this as any).send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({
          ok: false,
          status: "ERROR",
          error: "TOOL_NOT_ALLOWED",
          tool,
          required_capabilities: requiredCapabilities,
          retryable: false,
        }),
      },
    });
    (this as any).send?.({ type: "response.create" });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    if (event?.type === "response.function_call_arguments.done" && isPublicRestaurantTool(event.name)) {
      let args: Record<string, unknown>;
      try {
        args = parseObject(event.arguments);
      } catch (error) {
        (this as any).diagnostics?.fail?.("PUBLIC_TOOL_AUTHORIZATION_INVALID_ARGUMENTS_V25", "INVALID_AGENT_TOOL_ARGUMENTS", {
          tool: event.name,
          error: error instanceof Error ? error.message : String(error),
        });
        (this as any).send?.({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: event.call_id,
            output: JSON.stringify({ ok: false, status: "ERROR", error: "INVALID_ARGUMENTS", retryable: false }),
          },
        });
        (this as any).send?.({ type: "response.create" });
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
        this.sendAuthorizationFailureV25(event.call_id, event.name, decision.requiredCapabilities);
        return;
      }
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
