import { isPublicRestaurantTool } from "./public-tool-authorization.js";
import { semanticTurnRuntimeFor } from "./semantic-turn-runtime.js";

const INPUT_IGNORED = "restaurant_input_ignored";

export type SemanticToolAuthorityEvent = {
  name?: string;
  call_id?: string;
  arguments?: string;
};

function sendSessionToolChoice(session: any, toolChoice: "auto" | "required"): void {
  session.send?.({ type: "session.update", session: { type: "realtime", tool_choice: toolChoice } });
}

export function beginSemanticTurnFromAcousticEvidence(
  session: object,
  options: { itemId: string | null; source: string },
): void {
  const runtime = semanticTurnRuntimeFor(session);
  runtime.beginFromAcousticEvidence();
  const s = session as any;
  s.diagnostics?.checkpoint?.("SEMANTIC_TURN_BOOKKEEPING_RESET_FROM_ACOUSTIC_EVIDENCE_V29", {
    item_id: options.itemId,
    source: options.source,
    semantic_authority_acquired: false,
    tool_gate_armed: false,
    transcript_still_required: true,
    owner: "semantic_turn_runtime",
  });
}

export function armCallerDirectedSemanticAuthority(
  session: object,
  itemId: string,
  source: string,
): void {
  if (!itemId) return;
  semanticTurnRuntimeFor(session).armDirected(itemId);
  (session as any).diagnostics?.checkpoint?.("CALLER_DIRECTED_SEMANTIC_AUTHORITY_ARMED_V29", {
    item_id: itemId,
    source,
    one_shot: true,
    owner: "semantic_turn_runtime",
  });
}

export function armSemanticGate(session: object, transcript: string, itemId: string | null): boolean {
  const runtime = semanticTurnRuntimeFor(session);
  if (!runtime.armGate(itemId)) return false;
  sendSessionToolChoice(session as any, "required");
  const snapshot = runtime.snapshot();
  (session as any).diagnostics?.checkpoint?.("RESTAURANT_SEMANTIC_TOOL_GATE_ARMED_V29", {
    source: "completed_transcription",
    transcript_length: transcript.length,
    item_id: itemId,
    caller_directed_authority: Boolean(itemId && itemId === snapshot.directedItemId),
    owner: "semantic_turn_runtime",
  });
  return true;
}

export function releaseSemanticGate(session: object, tool: string): boolean {
  if (!semanticTurnRuntimeFor(session).releaseGate()) return false;
  sendSessionToolChoice(session as any, "auto");
  (session as any).diagnostics?.checkpoint?.("RESTAURANT_SEMANTIC_TOOL_GATE_RELEASED_V29", {
    tool,
    owner: "semantic_turn_runtime",
  });
  return true;
}

export function authorizePublicRestaurantTool(
  session: object,
  event: SemanticToolAuthorityEvent,
): { allowed: boolean; ignored: boolean; duplicateOf: string | null; directedIgnoreRejected: boolean } {
  if (!event.name || !isPublicRestaurantTool(event.name)) {
    return { allowed: true, ignored: false, duplicateOf: null, directedIgnoreRejected: false };
  }

  const s = session as any;
  const runtime = semanticTurnRuntimeFor(session);
  if (event.name === INPUT_IGNORED && runtime.directedAuthorityApplies()) {
    s.diagnostics?.checkpoint?.("BACKGROUND_INPUT_RECLASSIFICATION_BLOCKED_V29", {
      item_id: runtime.snapshot().activeItemId,
      model_tool: INPUT_IGNORED,
      authority: "caller_directed_barge_in_classifier",
      semantic_gate_preserved: true,
      presence_unchanged: true,
    });
    s.send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify({
          ok: false,
          status: "REJECTED",
          reason: "CALLER_DIRECTED_TURN_CONFIRMED",
          instruction: "The caller-directed turn is already authoritative. Select the appropriate public restaurant tool for the same user turn; do not use restaurant_input_ignored.",
        }),
      },
    });
    return { allowed: false, ignored: false, duplicateOf: null, directedIgnoreRejected: true };
  }

  const selection = runtime.selectTool(event.name);
  if (!selection.allowed) {
    s.diagnostics?.checkpoint?.("DUPLICATE_SEMANTIC_TOOL_BLOCKED_V29", {
      attempted_tool: event.name,
      authoritative_tool: selection.duplicateOf,
      same_caller_turn: true,
      business_action_executed: false,
      presence_unchanged: true,
    });
    s.send?.({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify({
          ok: false,
          status: "REJECTED",
          reason: "DUPLICATE_SEMANTIC_DECISION",
          authoritative_tool: selection.duplicateOf,
        }),
      },
    });
    return { allowed: false, ignored: false, duplicateOf: selection.duplicateOf, directedIgnoreRejected: false };
  }

  releaseSemanticGate(session, event.name);
  return {
    allowed: event.name !== INPUT_IGNORED,
    ignored: event.name === INPUT_IGNORED,
    duplicateOf: null,
    directedIgnoreRejected: false,
  };
}
