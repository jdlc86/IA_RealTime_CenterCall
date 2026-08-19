import type { ResponseOwnerState } from "./realtime-response-owner";

export type BargeInPublicToolRoute = "DEFER_TO_CLASSIFIER" | "ALLOW_SEMANTIC_PIPELINE";
export type ConfirmedBargeInPromotionRoute = "PROMOTE_SOURCE" | "DEFER_TO_NEWER_SPEECH";
export type DeferredBargeInTranscriptRoute = "WAIT_FOR_LATEST" | "PROMOTE_LATEST" | "FALLBACK_SOURCE";
export type IgnoredBargeInPlaybackRecoveryRoute = "KEEP_SILENT" | "RECOVER_LIVENESS";

/**
 * v40 is the single semantic authority while a normal-playback interruption is
 * still being classified. Lower layers must not acquire a public-tool decision
 * until that classification has resolved.
 */
export function decideBargeInPublicToolRoute(ownerState: ResponseOwnerState | null | undefined): BargeInPublicToolRoute {
  return ownerState === "BARGE_IN_CLASSIFYING"
    ? "DEFER_TO_CLASSIFIER"
    : "ALLOW_SEMANTIC_PIPELINE";
}

/**
 * A classifier result belongs to the acoustic item it classified. If a newer
 * caller speech item has already started before that result arrives, the older
 * item may still authorize interruption of playback but must not authorize a
 * response yet. Semantic promotion moves to the newer item without using a
 * timing window.
 */
export function decideConfirmedBargeInPromotion(
  classifiedItemId: string,
  latestCallerSpeechItemId: string | null | undefined,
): ConfirmedBargeInPromotionRoute {
  return latestCallerSpeechItemId && latestCallerSpeechItemId !== classifiedItemId
    ? "DEFER_TO_NEWER_SPEECH"
    : "PROMOTE_SOURCE";
}

/**
 * While promotion is deferred, only the transcript belonging to the newest
 * observed speech item may become semantic authority. If that exact transcript
 * is unusable, fall back to the already-confirmed source item instead of adding
 * a watchdog or arbitrary delay.
 */
export function decideDeferredBargeInTranscriptRoute(
  targetItemId: string,
  completedItemId: string | null | undefined,
  transcriptUsable: boolean,
): DeferredBargeInTranscriptRoute {
  if (!completedItemId || completedItemId !== targetItemId) return "WAIT_FOR_LATEST";
  return transcriptUsable ? "PROMOTE_LATEST" : "FALLBACK_SOURCE";
}

/**
 * SIP/WebRTC can clear provider playback on a VAD start before v40 has enough
 * semantic evidence to accept an interruption. A normal IGNORE remains silent
 * when playback survived. If the provider already destroyed playback, silence
 * would strand the call, so v40 must issue one bounded, non-business recovery.
 * Terminal state is absorbing and never permits recovery speech.
 */
export function decideIgnoredBargeInPlaybackRecovery(options: {
  providerClearedPlaybackBeforeDecision: boolean;
  terminal: boolean;
}): IgnoredBargeInPlaybackRecoveryRoute {
  if (options.terminal) return "KEEP_SILENT";
  return options.providerClearedPlaybackBeforeDecision ? "RECOVER_LIVENESS" : "KEEP_SILENT";
}
