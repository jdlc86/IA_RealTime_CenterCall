import type { TenantVadSettings } from "./protected-turn-detection";

export type RealtimeSpeechRequest = {
  instructions: string;
  purpose?: string;
  metadata?: Record<string, unknown>;
  isolated?: boolean;
  exactText?: string;
  tools?: "DISABLED" | "DEFAULT";
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
  createDefaultResponse(): void;
  cancelResponse(responseId: string): void;
  clearPlayback(): void;
  clearInput(): void;
  suspendInputDetection(): void;
  restoreInputDetection(settings?: TenantVadSettings): void;
}
