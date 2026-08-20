import { CallSession as CallSessionV44 } from "./call-session-v44-raw-vad-routing";
import { decideBargeInPublicToolRoute } from "./barge-in-semantic-authority";
import { isPublicRestaurantTool } from "./public-tool-authorization";
import { adaptRealtimeProviderEvents, realtimeCommandPortFor } from "./realtime-provider-runtime.js";
import { responseCoordinatorFor } from "./response-coordinator.js";

const BaseConstructor = CallSessionV44 as unknown as new (...args: any[]) => any;
const BasePrototype = CallSessionV44.prototype as any;

/** Compatibility adapter; ResponseCoordinator is the sole response-state owner. */
export class CallSession extends BaseConstructor {
  private async handleRealtimeMessage(data: unknown): Promise<void> {
    const ownerState = responseCoordinatorFor(this).snapshot().state;
    const event = adaptRealtimeProviderEvents(data).find(
      (candidate) => candidate.type === "SEMANTIC_TOOL_SELECTED" && isPublicRestaurantTool(candidate.name),
    );

    if (
      event?.type === "SEMANTIC_TOOL_SELECTED"
      && isPublicRestaurantTool(event.name)
      && decideBargeInPublicToolRoute(ownerState as any) === "DEFER_TO_CLASSIFIER"
    ) {
      (this as any).diagnostics?.checkpoint?.("PUBLIC_TOOL_DEFERRED_TO_BARGE_IN_CLASSIFIER_V45", {
        tool: event.name,
        call_id: event.callId ?? null,
        response_owner_state: ownerState,
        business_action_executed: false,
        semantic_authority_acquired: false,
        lower_layers_bypassed: true,
        owner: "response_coordinator",
      });
      if (event.callId) {
        realtimeCommandPortFor(this as any).submitToolResult({
          callId: event.callId,
          toolName: event.name,
          output: {
            ok: false,
            status: "DEFERRED",
            reason: "BARGE_IN_CLASSIFICATION_PENDING",
            speak: false,
            mutation: false,
          },
        });
      }
      return;
    }
    await BasePrototype.handleRealtimeMessage.call(this, data);
  }
}
