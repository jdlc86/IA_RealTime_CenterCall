import type {
  GeminiLiveCommandHost,
  GeminiLiveInitialSetup,
} from "./gemini-live-command-adapter.js";
import {
  requireConfirmedGeminiDeferredBargeInCandidate,
  type GeminiDeferredBargeInCandidate,
} from "./gemini-deferred-barge-in-candidate-owner.js";
import { telnyxL16PayloadToGeminiRealtimeInput } from "./gemini-telnyx-media-contract.js";

export type GeminiAuthorizedBargeInCommitSnapshot = Readonly<{
  state: "ACTIVE" | "FAILED";
  committedCandidates: number;
  committedChunks: number;
}>;

/**
 * Final provider-wire boundary for a semantically authorized deferred barge-in.
 *
 * Construction requires the exact immutable Live setup semantics needed for a
 * delayed interrupt. commit() then accepts only candidates minted by
 * GeminiDeferredBargeInCandidateOwner.confirmInterruption(). This keeps acoustic
 * detection/transcription and semantic authorization outside the provider wire.
 */
export class GeminiAuthorizedBargeInCommitAdapter {
  private state: GeminiAuthorizedBargeInCommitSnapshot["state"] = "ACTIVE";
  private committedCandidates = 0;
  private committedChunks = 0;
  private readonly committedItemIds = new Set<string>();

  constructor(
    private readonly host: GeminiLiveCommandHost,
    initialSetup: GeminiLiveInitialSetup,
  ) {
    if (initialSetup.manualActivityDetection !== true) {
      throw new Error("Gemini authorized barge-in requires manual activity detection");
    }
    if (initialSetup.manualActivityHandling !== "START_OF_ACTIVITY_INTERRUPTS") {
      throw new Error("Gemini authorized barge-in requires START_OF_ACTIVITY_INTERRUPTS setup");
    }
  }

  commit(value: unknown): GeminiAuthorizedBargeInCommitSnapshot {
    this.assertActive();
    const candidate = requireConfirmedGeminiDeferredBargeInCandidate(value);
    this.assertFresh(candidate);

    try {
      this.host.send({ realtimeInput: { activityStart: {} } });
      for (const payload of candidate.mediaPayloads) {
        this.host.send(telnyxL16PayloadToGeminiRealtimeInput(payload));
        this.committedChunks += 1;
      }
      this.host.send({ realtimeInput: { activityEnd: {} } });
      this.committedItemIds.add(candidate.itemId);
      this.committedCandidates += 1;
      return this.snapshot();
    } catch (error) {
      this.state = "FAILED";
      throw error;
    }
  }

  snapshot(): GeminiAuthorizedBargeInCommitSnapshot {
    return Object.freeze({
      state: this.state,
      committedCandidates: this.committedCandidates,
      committedChunks: this.committedChunks,
    });
  }

  private assertFresh(candidate: GeminiDeferredBargeInCandidate): void {
    if (this.committedItemIds.has(candidate.itemId)) {
      throw new Error(`Gemini deferred barge-in candidate already committed: ${candidate.itemId}`);
    }
    if (candidate.mediaPayloads.length === 0) {
      throw new Error(`Gemini deferred barge-in candidate has no replayable audio: ${candidate.itemId}`);
    }
  }

  private assertActive(): void {
    if (this.state !== "ACTIVE") {
      throw new Error("Gemini authorized barge-in commit adapter is failed");
    }
  }
}
