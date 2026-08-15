import { CallSession as CallSessionV26 } from "./call-session-v26";
import { isPublicRestaurantTool } from "./public-tool-authorization";

const BaseConstructor = CallSessionV26 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV26.prototype as any;

type RealtimeEvent = {
  type?: string;
  name?: string;
};

function readRealtimeText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return null;
}

/**
 * v27 makes restaurant scope a protocol invariant instead of a prompt-only rule.
 *
 * On every caller turn, Realtime is temporarily switched to tool_choice=required.
 * Lucia therefore cannot answer the caller directly before selecting one of the
 * public restaurant tools. Relevant requests go to the corresponding business
 * tool; unrelated or incoherent requests must go to restaurant_out_of_scope.
 * Once a public tool is selected, tool_choice returns to auto so Lucia can speak
 * the structured result naturally.
 */
export class CallSession extends BaseConstructor {
  private domainToolGateArmedV27 = false;

  private armDomainToolGateV27(source: string): void {
    const session = this as any;
    if (session.state === "closing" || session.hangupStarted === true) return;
    if (this.domainToolGateArmedV27) return;

    this.domainToolGateArmedV27 = true;
    session.send?.({
      type: "session.update",
      session: {
        type: "realtime",
        tool_choice: "required",
      },
    });
    session.diagnostics?.checkpoint?.("RESTAURANT_DOMAIN_TOOL_GATE_ARMED_V27", {
      source,
      scope: "restaurant_only",
      direct_freeform_before_tool: false,
    });
  }

  private releaseDomainToolGateV27(tool: string): void {
    if (!this.domainToolGateArmedV27) return;

    this.domainToolGateArmedV27 = false;
    const session = this as any;
    session.send?.({
      type: "session.update",
      session: {
        type: "realtime",
        tool_choice: "auto",
      },
    });
    session.diagnostics?.checkpoint?.("RESTAURANT_DOMAIN_TOOL_GATE_RELEASED_V27", {
      tool,
      scope_decision_source: "lucia_public_tool_selection",
    });
  }

  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const text = readRealtimeText(data);
    let event: RealtimeEvent | null = null;
    if (text) {
      try { event = JSON.parse(text) as RealtimeEvent; } catch { event = null; }
    }

    // Arm early enough that server-side VAD cannot auto-create a freeform model
    // response for a caller turn before the scope boundary is in place.
    if (event?.type === "input_audio_buffer.speech_started") {
      this.armDomainToolGateV27("caller_speech_started");
    }

    if (event?.type === "response.function_call_arguments.done" && isPublicRestaurantTool(event.name)) {
      this.releaseDomainToolGateV27(event.name);
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
