import { CallSession as CallSessionV43 } from "./call-session-v43-handoff-authorization";
import { hasUsablePresenceTranscript } from "./presence-overlap-evidence-policy.js";

const BaseConstructor = CallSessionV43 as unknown as new (...args: any[]) => any;

type RealtimeEvent = {
  type?: string;
  item_id?: string;
  transcript?: unknown;
};

/**
 * v44 separates recent caller presence from semantic turn ownership.
 *
 * v36 may intentionally discard an overlapping completed caller transcript while
 * another semantic turn still owns the pipeline. That discard must not execute
 * business logic or create a second response, but usable caller text is still
 * evidence that the caller is present. v44 refreshes only the v18 presence clock.
 */
export class CallSession extends BaseConstructor {
  protected onOverlappingTurnDroppedV36(event: RealtimeEvent): void {
    if (!hasUsablePresenceTranscript(event.transcript)) return;

    const session = this as any;
    session.refreshRecentUserPresenceV18?.("v36_overlapping_transcript_dropped");
    session.diagnostics?.checkpoint?.("OVERLAPPING_TURN_REFRESHED_PRESENCE_V44", {
      item_id: event.item_id ?? null,
      semantic_processing_unchanged: true,
      presence_only: true,
    });
  }
}
