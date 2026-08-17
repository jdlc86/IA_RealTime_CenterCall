import { CallSession as CallSessionV44 } from "./call-session-v44-raw-vad-routing";
import { decideBargeInPublicToolRoute } from "./barge-in-semantic-authority";
import { isPublicRestaurantTool } from "./public-tool-authorization";

const BaseConstructor = CallSessionV44 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV44.prototype as any;

type RealtimeEvent = {
  type?: string;
  name?: string;
  call_id?: string;
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

/**
 * v45 closes the semantic-authority leak exposed by a live barge-in asking for
 * business hours. While v40 owns BARGE_IN_CLASSIFYING, a lower historical layer
 * must not execute or record a public restaurant tool for that same acoustic
 * candidate. The ResponseOwner remains the single source of truth; v45 keeps no
 * duplicate classification state.
 */
export class CallSession extends BaseConstructor {
  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const event = parseEvent(data);
    const ownerState = (this as any).responseOwnerV40?.state as string | undefined;

    if (
      event?.type === "response.function_call_arguments.done"
      && event.name
      && isPublicRestaurantTool(event.name)
      && decideBargeInPublicToolRoute(ownerState as any) === "DEFER_TO_CLASSIFIER"
    ) {
      (this as any).diagnostics?.checkpoint?.("PUBLIC_TOOL_DEFERRED_TO_BARGE_IN_CLASSIFIER_V45", {
        tool: event.name,
        call_id: event.call_id ?? null,
        response_owner_state: ownerState ?? null,
        business_action_executed: false,
        semantic_authority_acquired: false,
        lower_layers_bypassed: true,
      });

      if (event.call_id) {
        (this as any).send?.({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: event.call_id,
            output: JSON.stringify({
              ok: false,
              status: "DEFERRED",
              reason: "BARGE_IN_CLASSIFICATION_PENDING",
              speak: false,
              mutation: false,
            }),
          },
        });
      }
      return;
    }

    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
