import type { RealtimeProviderEvent } from "./realtime-provider-event.js";
import type { AuthoritativeCallerTranscriptionPort } from "./authoritative-caller-transcription-port.js";
import type { GeminiLiveCommandHost, GeminiLiveInitialSetup } from "./gemini-live-command-adapter.js";
import { GeminiAuthorizedBargeInCommitAdapter } from "./gemini-authorized-barge-in-commit-adapter.js";
import { GeminiAuthorizedBargeInEffectRuntime } from "./gemini-authorized-barge-in-effect-runtime.js";
import { GeminiDeferredBargeInAcousticRuntime } from "./gemini-deferred-barge-in-acoustic-runtime.js";
import { GeminiNormalCallerTurnCommitAdapter } from "./gemini-normal-caller-turn-commit-adapter.js";
import type { GeminiTelnyxAcousticVadConfig } from "./gemini-telnyx-acoustic-vad.js";
import {
  GeminiTelnyxSessionBridge,
  type GeminiTelnyxGeminiObservation,
  type GeminiTelnyxSessionSnapshot,
  type TelnyxMediaCommandHost,
} from "./gemini-telnyx-session-bridge.js";

export type GeminiDeferredInputDecision = "INTERRUPT" | "IGNORE";

export type GeminiTelnyxDeferredInputSnapshot = Readonly<{
  session: GeminiTelnyxSessionSnapshot;
  activeCallerItemId: string | null;
  playbackResponseIdAtSpeechStart: string | null;
  awaitingBargeInDecision: boolean;
}>;

export type GeminiTelnyxDeferredInputObservation = Readonly<{
  events: readonly RealtimeProviderEvent[];
  snapshot: GeminiTelnyxDeferredInputSnapshot;
}>;

type CallerTurnContext = {
  itemId: string;
  playbackResponseIdAtSpeechStart: string | null;
};

/**
 * Single Gemini/Telnyx caller-input authority for manual activity mode.
 *
 * The underlying session bridge is permanently DEFERred: ordered Telnyx caller
 * audio can never bypass this coordinator and reach Gemini directly. Sample-count
 * VAD and authoritative STT produce neutral caller events first. Speech that began
 * with no Telnyx playback is released as a normal caller turn and committed only
 * while the session is idle. Speech that began while playback was owned remains
 * buffered until an external semantic decision explicitly INTERRUPTs or IGNOREs it.
 *
 * Playback identity is captured at the first acoustic speech evidence (before the
 * VAD minimum-speech threshold is satisfied), so a naturally draining mark cannot
 * retroactively convert overlapping speech into a normal turn. No wall-clock timing
 * or Gemini input-transcription chunk is used.
 */
export class GeminiTelnyxDeferredInputCoordinator {
  private readonly sessionBridge: GeminiTelnyxSessionBridge;
  private readonly acoustic: GeminiDeferredBargeInAcousticRuntime;
  private readonly normalCommit: GeminiNormalCallerTurnCommitAdapter;
  private readonly bargeEffects: GeminiAuthorizedBargeInEffectRuntime;
  private provisionalPlaybackResponseId: string | null | undefined;
  private callerTurn: CallerTurnContext | null = null;
  private awaitingBargeInDecision = false;

  constructor(
    geminiHost: GeminiLiveCommandHost,
    telnyxHost: TelnyxMediaCommandHost,
    initialSetup: GeminiLiveInitialSetup,
    transcription: AuthoritativeCallerTranscriptionPort,
    vadConfig: GeminiTelnyxAcousticVadConfig,
    options: Readonly<{ maxBufferedChunks?: number; maxBufferedPayloadChars?: number }> = {},
  ) {
    if (initialSetup.manualActivityDetection !== true) {
      throw new Error("Gemini deferred input coordinator requires manual activity detection");
    }
    if (initialSetup.manualActivityHandling !== "START_OF_ACTIVITY_INTERRUPTS") {
      throw new Error("Gemini deferred input coordinator requires START_OF_ACTIVITY_INTERRUPTS setup");
    }
    this.sessionBridge = new GeminiTelnyxSessionBridge(
      geminiHost,
      telnyxHost,
      initialSetup,
      { inboundAudioMode: "DEFER" },
    );
    this.acoustic = new GeminiDeferredBargeInAcousticRuntime(transcription, vadConfig, options);
    this.normalCommit = new GeminiNormalCallerTurnCommitAdapter(geminiHost, initialSetup, this.sessionBridge);
    this.bargeEffects = new GeminiAuthorizedBargeInEffectRuntime(
      new GeminiAuthorizedBargeInCommitAdapter(geminiHost, initialSetup),
      this.sessionBridge,
    );
  }

  start(): GeminiTelnyxDeferredInputSnapshot {
    this.sessionBridge.start();
    return this.snapshot();
  }

  observeGemini(data: unknown): GeminiTelnyxGeminiObservation {
    return this.sessionBridge.observeGemini(data);
  }

  async observeTelnyx(data: unknown): Promise<GeminiTelnyxDeferredInputObservation> {
    const telnyx = this.sessionBridge.observeTelnyx(data);
    const events: RealtimeProviderEvent[] = [...telnyx.events];

    for (const payload of telnyx.telnyx.mediaPayloads) {
      const before = this.acoustic.snapshot();
      const observation = await this.acoustic.observeTelnyxMedia(payload);
      const after = observation.snapshot;

      if (
        before.vad.state === "SILENCE"
        && before.vad.candidateSpeechSamples === 0
        && after.vad.state === "SILENCE"
        && after.vad.candidateSpeechSamples > 0
        && this.provisionalPlaybackResponseId === undefined
      ) {
        this.provisionalPlaybackResponseId = this.sessionBridge.activePlaybackResponseId();
      }

      const started = observation.events.find((event) => event.type === "CALLER_SPEECH_STARTED");
      if (started) {
        if (this.callerTurn) throw new Error(`Gemini deferred input already owns caller item ${this.callerTurn.itemId}`);
        const itemId = started.itemId;
        if (!itemId) throw new Error("Gemini deferred input caller speech start requires itemId");
        this.callerTurn = {
          itemId,
          playbackResponseIdAtSpeechStart:
            this.provisionalPlaybackResponseId === undefined
              ? this.sessionBridge.activePlaybackResponseId()
              : this.provisionalPlaybackResponseId,
        };
        this.provisionalPlaybackResponseId = undefined;
      } else if (
        after.vad.state === "SILENCE"
        && after.vad.candidateSpeechSamples === 0
        && !after.transcription.candidate.activeItemId
      ) {
        this.provisionalPlaybackResponseId = undefined;
      }

      events.push(...observation.events);

      const completed = observation.events.find((event) => event.type === "CALLER_TRANSCRIPT_COMPLETED");
      if (completed) this.routeCompletedCallerTurn(completed);
    }

    return Object.freeze({ events: Object.freeze(events), snapshot: this.snapshot() });
  }

  resolveBargeIn(itemId: string, decision: GeminiDeferredInputDecision): GeminiTelnyxDeferredInputSnapshot {
    const context = this.requireAwaitingBargeIn(itemId);
    if (decision === "IGNORE") {
      this.acoustic.ignoreCandidate(context.itemId);
      this.clearCallerTurn();
      return this.snapshot();
    }

    const target = context.playbackResponseIdAtSpeechStart;
    if (!target) throw new Error("Gemini deferred input interruption has no playback target");

    const activeResponseId = this.sessionBridge.activeResponseId();
    const activePlaybackResponseId = this.sessionBridge.activePlaybackResponseId();
    if (activeResponseId && activeResponseId !== target) {
      throw new Error(`Gemini deferred input playback target superseded by active response ${activeResponseId}`);
    }

    // If the original playback fully drained before semantic resolution and no new
    // response owns the session, there is nothing left to cancel or clear. Preserve
    // the caller speech by releasing it as an ordinary turn instead of fabricating
    // a stale interruption effect.
    if (!activeResponseId && !activePlaybackResponseId) {
      const turn = this.acoustic.releaseNormalTurn(context.itemId);
      this.normalCommit.commit(turn);
      this.clearCallerTurn();
      return this.snapshot();
    }

    if (activePlaybackResponseId && activePlaybackResponseId !== target) {
      throw new Error(`Gemini deferred input playback target superseded by ${activePlaybackResponseId}`);
    }

    const candidate = this.acoustic.confirmInterruption(context.itemId);
    this.bargeEffects.arm(candidate);
    this.bargeEffects.cancelResponse(target);
    this.bargeEffects.clearPlayback();
    this.clearCallerTurn();
    return this.snapshot();
  }

  snapshot(): GeminiTelnyxDeferredInputSnapshot {
    return Object.freeze({
      session: this.sessionBridge.snapshot(),
      activeCallerItemId: this.callerTurn?.itemId ?? null,
      playbackResponseIdAtSpeechStart: this.callerTurn?.playbackResponseIdAtSpeechStart ?? null,
      awaitingBargeInDecision: this.awaitingBargeInDecision,
    });
  }

  private routeCompletedCallerTurn(event: Extract<RealtimeProviderEvent, { type: "CALLER_TRANSCRIPT_COMPLETED" }>): void {
    const context = this.callerTurn;
    if (!context || event.itemId !== context.itemId) {
      throw new Error(`Gemini deferred input transcript does not match active caller item ${context?.itemId ?? "<none>"}`);
    }
    if (context.playbackResponseIdAtSpeechStart) {
      this.awaitingBargeInDecision = true;
      return;
    }
    const turn = this.acoustic.releaseNormalTurn(context.itemId);
    this.normalCommit.commit(turn);
    this.clearCallerTurn();
  }

  private requireAwaitingBargeIn(itemId: string): CallerTurnContext {
    const context = this.callerTurn;
    const normalized = itemId.trim();
    if (!this.awaitingBargeInDecision || !context || !normalized || normalized !== context.itemId) {
      throw new Error(`Gemini deferred input is not awaiting barge-in decision for ${normalized || "<empty>"}`);
    }
    if (!context.playbackResponseIdAtSpeechStart) {
      throw new Error("Gemini deferred input pending decision lacks playback ownership");
    }
    return context;
  }

  private clearCallerTurn(): void {
    this.callerTurn = null;
    this.awaitingBargeInDecision = false;
    this.provisionalPlaybackResponseId = undefined;
  }
}
