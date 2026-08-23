import type { RealtimeProviderCommandPort } from "./realtime-provider-command-port.js";
import type { AssistantSpeechKind, RealtimeProviderEvent } from "./realtime-provider-event.js";
import type { GeminiLiveCommandHost, GeminiLiveInitialSetup } from "./gemini-live-command-adapter.js";
import {
  GeminiLiveSessionRuntime,
  type GeminiLiveCallerActivityBoundary,
  type GeminiLiveSessionRuntimeObservation,
} from "./gemini-live-session-runtime.js";
import type { GeminiLiveSessionSnapshot } from "./gemini-live-session-owner.js";
import {
  GeminiTelnyxMediaBridge,
  type GeminiTelnyxInboundAudioMode,
  type GeminiTelnyxMediaBridgeSnapshot,
  type GeminiTelnyxInboundObservation,
  type TelnyxMediaCommandHost,
} from "./gemini-telnyx-media-bridge.js";

export type GeminiTelnyxSessionBridgeOptions = Readonly<{
  inboundAudioMode?: GeminiTelnyxInboundAudioMode;
}>;

export type GeminiTelnyxSessionSnapshot = Readonly<{
  session: GeminiLiveSessionSnapshot;
  media: GeminiTelnyxMediaBridgeSnapshot;
}>;

export type GeminiTelnyxGeminiObservation = Readonly<{
  events: readonly RealtimeProviderEvent[];
  transcriptionChunks: GeminiLiveSessionRuntimeObservation["transcriptionChunks"];
  cancelledToolCallIds: readonly string[];
  emittedAudioChunks: number;
  drainMark: string | null;
  snapshot: GeminiTelnyxSessionSnapshot;
}>;

export type GeminiTelnyxTelnyxObservation = Readonly<{
  events: readonly RealtimeProviderEvent[];
  telnyx: GeminiTelnyxInboundObservation["telnyx"];
  snapshot: GeminiTelnyxSessionSnapshot;
}>;

function responseIdFromStartedEvent(events: readonly RealtimeProviderEvent[]): string | null {
  const started = events.find((event) => event.type === "ASSISTANT_RESPONSE_STARTED");
  return started && "responseId" in started && typeof started.responseId === "string"
    ? started.responseId
    : null;
}

function completedResponseId(events: readonly RealtimeProviderEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "ASSISTANT_RESPONSE_COMPLETED" && event.status === "completed") {
      const responseId = event.responseId;
      if (typeof responseId !== "string" || !responseId.trim()) {
        throw new Error("Gemini completed response requires owned responseId");
      }
      return responseId;
    }
  }
  return null;
}

function orderComposedEvents(
  sessionEvents: readonly RealtimeProviderEvent[],
  playbackEvents: readonly RealtimeProviderEvent[],
): readonly RealtimeProviderEvent[] {
  const started = sessionEvents.filter((event) => event.type === "ASSISTANT_RESPONSE_STARTED");
  const completed = sessionEvents.filter((event) => event.type === "ASSISTANT_RESPONSE_COMPLETED");
  const other = sessionEvents.filter(
    (event) => event.type !== "ASSISTANT_RESPONSE_STARTED" && event.type !== "ASSISTANT_RESPONSE_COMPLETED",
  );
  return Object.freeze([...started, ...other, ...playbackEvents, ...completed]);
}

/**
 * Isolated Gemini/Telnyx composition boundary.
 *
 * GeminiLiveSessionRuntime is the only response-lifecycle authority. The media
 * bridge never accepts caller-supplied response identity through this facade:
 * output audio is correlated only with the response id owned by the session.
 * Normal generation completion requests a Telnyx drain mark after all audio in
 * the same provider message has been written. Interruptions deliberately do not
 * clear playback here; the neutral ResponseCoordinator remains that authority.
 *
 * inboundAudioMode is immutable for the bridge lifetime. DEFER prevents caller
 * media from reaching Gemini so a higher edge composition can own VAD/STT and
 * semantic barge-in authorization before committing any caller activity.
 */
export class GeminiTelnyxSessionBridge {
  private readonly session: GeminiLiveSessionRuntime;
  private readonly media: GeminiTelnyxMediaBridge;

  constructor(
    geminiHost: GeminiLiveCommandHost,
    telnyxHost: TelnyxMediaCommandHost,
    initialSetup: GeminiLiveInitialSetup,
    options: GeminiTelnyxSessionBridgeOptions = {},
  ) {
    this.session = new GeminiLiveSessionRuntime(geminiHost, initialSetup);
    this.media = new GeminiTelnyxMediaBridge(
      geminiHost,
      telnyxHost,
      options.inboundAudioMode ?? "FORWARD",
    );
  }

  get commandPort(): RealtimeProviderCommandPort {
    return this.session.commandPort;
  }

  start(): GeminiTelnyxSessionSnapshot {
    this.session.start();
    return this.snapshot();
  }

  beginCallerActivity(): GeminiLiveCallerActivityBoundary {
    return this.session.beginCallerActivity();
  }

  endCallerActivity(): GeminiLiveCallerActivityBoundary {
    return this.session.endCallerActivity();
  }

  activeResponseId(): string | null {
    return this.session.snapshot().activeResponseId;
  }

  activePlaybackResponseId(): string | null {
    return this.media.activePlaybackResponseId();
  }

  clearActivePlayback(responseId: string): string | null {
    const normalized = responseId.trim();
    const activeResponseId = this.session.snapshot().activeResponseId;
    if (!normalized || !activeResponseId || normalized !== activeResponseId) {
      throw new Error(`Gemini playback clear requires active owned response ${normalized || "<empty>"}`);
    }
    return this.media.clearPlayback(normalized);
  }

  observeGemini(
    data: unknown,
    kind: AssistantSpeechKind = "NORMAL",
  ): GeminiTelnyxGeminiObservation {
    const beforeResponseId = this.session.snapshot().activeResponseId;
    const sessionObservation = this.session.observe(data);
    const responseId = responseIdFromStartedEvent(sessionObservation.events)
      ?? beforeResponseId
      ?? sessionObservation.snapshot.activeResponseId;
    const mediaObservation = this.media.observeGemini(data, responseId, kind);
    const completedId = completedResponseId(sessionObservation.events);
    const drainMark = completedId ? this.media.finishPlayback(completedId) : null;

    return Object.freeze({
      events: orderComposedEvents(sessionObservation.events, mediaObservation.playbackEvents),
      transcriptionChunks: sessionObservation.transcriptionChunks,
      cancelledToolCallIds: sessionObservation.cancelledToolCallIds,
      emittedAudioChunks: mediaObservation.emitted,
      drainMark,
      snapshot: this.snapshot(),
    });
  }

  observeTelnyx(data: unknown): GeminiTelnyxTelnyxObservation {
    const observation = this.media.observeTelnyx(data);
    return Object.freeze({
      events: observation.playbackEvents,
      telnyx: observation.telnyx,
      snapshot: this.snapshot(),
    });
  }

  snapshot(): GeminiTelnyxSessionSnapshot {
    return Object.freeze({
      session: this.session.snapshot(),
      media: this.media.snapshot(),
    });
  }

  close(): GeminiTelnyxSessionSnapshot {
    this.session.close();
    return this.snapshot();
  }
}
