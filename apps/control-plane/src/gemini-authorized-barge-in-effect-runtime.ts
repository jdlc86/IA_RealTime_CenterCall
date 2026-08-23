import { GeminiAuthorizedBargeInCommitAdapter } from "./gemini-authorized-barge-in-commit-adapter.js";
import {
  requireConfirmedGeminiDeferredBargeInCandidate,
  type GeminiDeferredBargeInCandidate,
} from "./gemini-deferred-barge-in-candidate-owner.js";
import { GeminiTelnyxSessionBridge } from "./gemini-telnyx-session-bridge.js";

export type GeminiAuthorizedBargeInEffectSnapshot = Readonly<{
  state: "ACTIVE" | "FAILED";
  armedItemId: string | null;
  cancelledResponseId: string | null;
  committedInterruptions: number;
  clearedPlaybacks: number;
}>;

/**
 * Executes only the provider-edge effects of an already-authorized barge-in.
 *
 * Semantic authority stays outside this runtime. A confirmed candidate must be
 * armed first; then the neutral effect order is preserved structurally:
 * cancel_response(responseId) commits the interrupting caller activity to Gemini,
 * and only afterwards may clear_playback clear the correlated Telnyx playout.
 *
 * Gemini may release response lifecycle ownership before Telnyx finishes playing
 * the same response. In that bounded race, playback ownership is sufficient to
 * preserve the original barge-in target. A different active response always wins
 * and causes a fail-closed identity conflict.
 *
 * No provider event, timer, transcript chunk or acoustic observation can arm this
 * runtime by itself.
 */
export class GeminiAuthorizedBargeInEffectRuntime {
  private state: GeminiAuthorizedBargeInEffectSnapshot["state"] = "ACTIVE";
  private armedCandidate: GeminiDeferredBargeInCandidate | null = null;
  private cancelledResponseId: string | null = null;
  private committedInterruptions = 0;
  private clearedPlaybacks = 0;

  constructor(
    private readonly commitAdapter: GeminiAuthorizedBargeInCommitAdapter,
    private readonly sessionBridge: GeminiTelnyxSessionBridge,
  ) {}

  arm(value: unknown): GeminiAuthorizedBargeInEffectSnapshot {
    this.assertActive();
    if (this.armedCandidate || this.cancelledResponseId) {
      throw new Error("Gemini authorized barge-in effect runtime already owns an in-flight interruption");
    }
    this.armedCandidate = requireConfirmedGeminiDeferredBargeInCandidate(value);
    return this.snapshot();
  }

  cancelResponse(responseId: string): GeminiAuthorizedBargeInEffectSnapshot {
    this.assertActive();
    const candidate = this.armedCandidate;
    if (!candidate) throw new Error("Gemini cancel_response requires an armed authorized candidate");

    const normalized = responseId.trim();
    const activeResponseId = this.sessionBridge.activeResponseId();
    const activePlaybackResponseId = this.sessionBridge.activePlaybackResponseId();
    const responseMatches = activeResponseId === normalized;
    const playbackMatches = activePlaybackResponseId === normalized;
    const conflictingActiveResponse = Boolean(activeResponseId && activeResponseId !== normalized);

    if (
      !normalized
      || conflictingActiveResponse
      || (!responseMatches && !playbackMatches)
    ) {
      this.fail();
      throw new Error(
        `Gemini cancel_response identity mismatch: response=${activeResponseId ?? "<none>"}, playback=${activePlaybackResponseId ?? "<none>"}`,
      );
    }

    try {
      this.commitAdapter.commit(candidate);
      this.armedCandidate = null;
      this.cancelledResponseId = normalized;
      this.committedInterruptions += 1;
      return this.snapshot();
    } catch (error) {
      this.fail();
      throw error;
    }
  }

  clearPlayback(): { mark: string | null; snapshot: GeminiAuthorizedBargeInEffectSnapshot } {
    this.assertActive();
    const responseId = this.cancelledResponseId;
    if (!responseId) throw new Error("Gemini clear_playback requires prior authorized cancel_response");
    try {
      const mark = this.sessionBridge.clearActivePlayback(responseId);
      this.cancelledResponseId = null;
      this.clearedPlaybacks += 1;
      return Object.freeze({ mark, snapshot: this.snapshot() });
    } catch (error) {
      this.fail();
      throw error;
    }
  }

  snapshot(): GeminiAuthorizedBargeInEffectSnapshot {
    return Object.freeze({
      state: this.state,
      armedItemId: this.armedCandidate?.itemId ?? null,
      cancelledResponseId: this.cancelledResponseId,
      committedInterruptions: this.committedInterruptions,
      clearedPlaybacks: this.clearedPlaybacks,
    });
  }

  private fail(): void {
    this.state = "FAILED";
    this.armedCandidate = null;
    this.cancelledResponseId = null;
  }

  private assertActive(): void {
    if (this.state !== "ACTIVE") throw new Error("Gemini authorized barge-in effect runtime is failed");
  }
}
