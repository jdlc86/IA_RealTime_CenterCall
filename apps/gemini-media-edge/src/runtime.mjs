export * from "./runtime-core.mjs";

import {
  BoundPlaybackGate,
  createGeminiMediaEdgeRuntime as createCoreRuntime,
} from "./runtime-core.mjs";
import { bindNextCallerInputDiagnosticContext } from "./caller-input.mjs";
import {
  createGeminiPostToolControlSink,
  installGeminiPostToolPlaybackSuppression,
} from "./post-tool-provider-audio-guard.mjs";

installGeminiPostToolPlaybackSuppression(BoundPlaybackGate);

/**
 * Observability and Gemini-specific playback composition wrapper around the
 * proven media runtime. The post-tool guard only prevents Gemini Live's
 * provider-owned automatic audio from taking Telnyx while the existing Control
 * Plane has selected governed post-tool speech; normal provider audio is
 * unchanged and OpenAI never traverses this module.
 */
export function createGeminiMediaEdgeRuntime(options) {
  const downstream = typeof options?.observeDiagnostic === "function" ? options.observeDiagnostic : () => {};
  const observeDiagnostic = (diagnostic) => {
    if (diagnostic?.stage === "MEDIA_SOCKET_AUTHORIZED") {
      bindNextCallerInputDiagnosticContext({
        tenantId: diagnostic.tenantId,
        callControlId: diagnostic.callControlId,
      });
    }
    downstream(diagnostic);
  };

  const bindControlSession = typeof options?.bindControlSession === "function"
    ? (identity, sink) => options.bindControlSession(identity, createGeminiPostToolControlSink(sink, {
        onArmed() {
          observeDiagnostic({
            stage: "POST_TOOL_PROVIDER_AUDIO_SUPPRESSION_ARMED",
            tenantId: identity.tenantId,
            callControlId: identity.callControlId,
          });
        },
        onBindingSuppressed() {
          observeDiagnostic({
            stage: "POST_TOOL_PROVIDER_AUDIO_SUPPRESSION_BOUND",
            tenantId: identity.tenantId,
            callControlId: identity.callControlId,
          });
        },
        onGovernedDeferred() {
          observeDiagnostic({
            stage: "POST_TOOL_GOVERNED_SPEECH_DEFERRED_FOR_PROVIDER_DRAIN",
            tenantId: identity.tenantId,
            callControlId: identity.callControlId,
          });
        },
        onReleasedAfterDrain() {
          observeDiagnostic({
            stage: "POST_TOOL_PROVIDER_AUDIO_SUPPRESSION_RELEASED_AFTER_DRAIN",
            tenantId: identity.tenantId,
            callControlId: identity.callControlId,
          });
        },
      }))
    : undefined;

  return createCoreRuntime({
    ...options,
    observeDiagnostic,
    ...(bindControlSession ? { bindControlSession } : {}),
    callerInputOptions: {
      ...(options?.callerInputOptions ?? {}),
      observeDiagnostic,
    },
  });
}
