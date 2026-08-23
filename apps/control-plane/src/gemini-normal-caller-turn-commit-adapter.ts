import type { GeminiLiveCommandHost, GeminiLiveInitialSetup } from "./gemini-live-command-adapter.js";
import {
  requireReleasedGeminiDeferredCallerTurn,
  type GeminiDeferredCallerTurn,
} from "./gemini-deferred-barge-in-candidate-owner.js";
import { telnyxL16PayloadToGeminiRealtimeInput } from "./gemini-telnyx-media-contract.js";
import { GeminiTelnyxSessionBridge } from "./gemini-telnyx-session-bridge.js";

export type GeminiNormalCallerTurnCommitSnapshot = Readonly<{
  state: "ACTIVE" | "FAILED";
  committedTurns: number;
  committedChunks: number;
}>;

/**
 * Provider commit boundary for a completed non-barge-in caller turn.
 *
 * A normal turn may reach Gemini only after authoritative STT released it through
 * releaseNormalTurn(). This adapter additionally requires the session to own no
 * active response and no Telnyx playback before emitting activityStart/audio/
 * activityEnd. Therefore a normal caller turn cannot double as an interruption.
 */
export class GeminiNormalCallerTurnCommitAdapter {
  private state: GeminiNormalCallerTurnCommitSnapshot["state"] = "ACTIVE";
  private committedTurns = 0;
  private committedChunks = 0;
  private readonly committedItemIds = new Set<string>();

  constructor(
    private readonly host: GeminiLiveCommandHost,
    initialSetup: GeminiLiveInitialSetup,
    private readonly sessionBridge: GeminiTelnyxSessionBridge,
  ) {
    if (initialSetup.manualActivityDetection !== true) {
      throw new Error("Gemini normal caller turn commit requires manual activity detection");
    }
  }

  commit(value: unknown): GeminiNormalCallerTurnCommitSnapshot {
    this.assertActive();
    const turn = requireReleasedGeminiDeferredCallerTurn(value);
    this.assertFresh(turn);
    const activeResponseId = this.sessionBridge.activeResponseId();
    const activePlaybackResponseId = this.sessionBridge.activePlaybackResponseId();
    if (activeResponseId || activePlaybackResponseId) {
      throw new Error(
        `Gemini normal caller turn requires idle session: response=${activeResponseId ?? "<none>"}, playback=${activePlaybackResponseId ?? "<none>"}`,
      );
    }

    try {
      this.host.send({ realtimeInput: { activityStart: {} } });
      for (const payload of turn.mediaPayloads) {
        this.host.send(telnyxL16PayloadToGeminiRealtimeInput(payload));
        this.committedChunks += 1;
      }
      this.host.send({ realtimeInput: { activityEnd: {} } });
      this.committedItemIds.add(turn.itemId);
      this.committedTurns += 1;
      return this.snapshot();
    } catch (error) {
      this.state = "FAILED";
      throw error;
    }
  }

  snapshot(): GeminiNormalCallerTurnCommitSnapshot {
    return Object.freeze({
      state: this.state,
      committedTurns: this.committedTurns,
      committedChunks: this.committedChunks,
    });
  }

  private assertFresh(turn: GeminiDeferredCallerTurn): void {
    if (this.committedItemIds.has(turn.itemId)) {
      throw new Error(`Gemini normal caller turn already committed: ${turn.itemId}`);
    }
    if (turn.mediaPayloads.length === 0) {
      throw new Error(`Gemini normal caller turn has no replayable audio: ${turn.itemId}`);
    }
  }

  private assertActive(): void {
    if (this.state !== "ACTIVE") throw new Error("Gemini normal caller turn commit adapter is failed");
  }
}
