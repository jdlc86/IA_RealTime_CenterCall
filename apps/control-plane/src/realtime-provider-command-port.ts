export type RealtimeInputDetectionSettings = {
  threshold?: number;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  idleTimeoutMs?: number;
  createResponse?: boolean;
  interruptResponse?: boolean;
};

export type RealtimeSpeechRequest = {
  instructions: string;
  requestId?: string;
  purpose?: string;
  metadata?: Record<string, unknown>;
  isolated?: boolean;
  exactText?: string;
  tools?: "DISABLED" | "DEFAULT";
};

export type RealtimeTextDecisionRequest = {
  instructions: string;
  inputText: string;
  requestId?: string;
  purpose?: string;
  metadata?: Record<string, unknown>;
  maxOutputTokens?: number;
};

/**
 * Provider-neutral command boundary for live conversational runtimes.
 *
 * Call lifecycle, response ownership and business policies describe intent in
 * these terms. Provider adapters are solely responsible for translating that
 * intent to OpenAI Realtime, Gemini Live, or another realtime protocol.
 */
export interface RealtimeProviderCommandPort {
  speak(request: RealtimeSpeechRequest): void;
  requestTextDecision(request: RealtimeTextDecisionRequest): void;
  createDefaultResponse(): void;
  cancelResponse(responseId: string): void;
  clearPlayback(): void;
  clearInput(): void;
  discardInputItem(itemId: string): void;
  suspendInputDetection(): void;
  beginNonInterruptingListening(settings?: RealtimeInputDetectionSettings): void;
  restoreInputDetection(settings?: RealtimeInputDetectionSettings): void;
}
