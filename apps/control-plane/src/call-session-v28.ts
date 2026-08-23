import { CallSession as CallSessionV27 } from "./call-session-v27";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";

const BaseConstructor = CallSessionV27 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV27.prototype as any;
const HUMAN_ASSISTANCE = "restaurant_human_assistance";

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool arguments must be a JSON object");
  return parsed as Record<string, unknown>;
}

/**
 * v28 closes the remaining intent-coverage gap: restaurant matters that require
 * human intervention now have an explicit public tool instead of being forced
 * into out_of_scope or freeform speech. There is deliberately no fake transfer:
 * until a real transfer transport is configured the tool reports that limitation
 * authoritatively.
 *
 * Startup policy is intentionally not owned here. The active direct-agent layers
 * install provider-neutral bootstrap policy; v28 only owns the runtime human
 * assistance behavior below.
 */
export class CallSession extends BaseConstructor {
  private sendOutputV28(callId: string | undefined, output: Record<string, unknown>): void {
    (this as any).send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
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

    if (event?.type === "response.function_call_arguments.done" && event.name === HUMAN_ASSISTANCE) {
      let args: Record<string, unknown>;
      try {
        args = parseArgs(event.arguments);
      } catch (error) {
        this.sendOutputV28(event.call_id, {
          ok: false,
          status: "ERROR",
          error: "INVALID_ARGUMENTS",
          retryable: false,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const reason = typeof args.reason === "string" ? args.reason : "OTHER_RESTAURANT_MATTER";
      const contextSummary = typeof args.context_summary === "string" && args.context_summary.trim()
        ? args.context_summary.trim().slice(0, 500)
        : undefined;

      const lifecycle = conversationLifecyclePortFor(this);
      lifecycle.validateUserTurn("agent_tool");
      lifecycle.suspendForTool(HUMAN_ASSISTANCE);
      (this as any).diagnostics?.checkpoint?.("DIRECT_HUMAN_ASSISTANCE_REQUESTED_V28", {
        reason,
        has_context_summary: Boolean(contextSummary),
        transfer_available: false,
      });

      this.sendOutputV28(event.call_id, {
        ok: true,
        status: "HUMAN_ASSISTANCE_REQUIRED",
        reason,
        transfer_available: false,
        callback_created: false,
        human_notified: false,
        instruction: "Esta gestión necesita atención de una persona del restaurante, pero no hay una transferencia telefónica ni callback automático configurados. No prometas transferencia, callback ni que alguien haya sido avisado. Explica esta limitación brevemente y ofrece continuar con cualquier gestión que sí puedas resolver con tus herramientas.",
      });
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
