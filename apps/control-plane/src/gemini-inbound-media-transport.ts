import type { AuthoritativeCallerTranscriptionPort } from "./authoritative-caller-transcription-port.js";
import type { GeminiLiveCommandHost, GeminiLiveInitialSetup } from "./gemini-live-command-adapter.js";
import type { GeminiTelnyxAcousticVadConfig } from "./gemini-telnyx-acoustic-vad.js";
import {
  GeminiTelnyxDeferredInputCoordinator,
} from "./gemini-telnyx-deferred-input-coordinator.js";
import type { TelnyxMediaCommandHost } from "./gemini-telnyx-media-bridge.js";
import type { GeminiInboundRealtimeRoute } from "./inbound-realtime-transport-composition.js";

export type GeminiInboundMediaTransportDependencies = Readonly<{
  geminiHost: GeminiLiveCommandHost;
  telnyxHost: TelnyxMediaCommandHost;
  initialSetup: GeminiLiveInitialSetup;
  transcription: AuthoritativeCallerTranscriptionPort;
  vadConfig: GeminiTelnyxAcousticVadConfig;
  bufferLimits?: Readonly<{
    maxBufferedChunks?: number;
    maxBufferedPayloadChars?: number;
  }>;
}>;

export type GeminiInboundMediaTransport = Readonly<{
  route: GeminiInboundRealtimeRoute;
  coordinator: GeminiTelnyxDeferredInputCoordinator;
}>;

/**
 * Inert composition of the Gemini/Telnyx media transport.
 *
 * Hosts are injected and the coordinator is deliberately NOT started here. This
 * boundary performs no provider connection or media side effect; callers retain
 * explicit ownership of start() after traffic admission and edge resources exist.
 */
export function composeGeminiInboundMediaTransport(
  route: GeminiInboundRealtimeRoute,
  dependencies: GeminiInboundMediaTransportDependencies,
): GeminiInboundMediaTransport {
  if (route.provider !== "GEMINI" || route.transport !== "GEMINI_MEDIA_BRIDGE") {
    throw new Error(`Gemini inbound media transport requires GEMINI_MEDIA_BRIDGE route`);
  }

  const coordinator = new GeminiTelnyxDeferredInputCoordinator(
    dependencies.geminiHost,
    dependencies.telnyxHost,
    dependencies.initialSetup,
    dependencies.transcription,
    dependencies.vadConfig,
    dependencies.bufferLimits,
  );

  return Object.freeze({ route, coordinator });
}
