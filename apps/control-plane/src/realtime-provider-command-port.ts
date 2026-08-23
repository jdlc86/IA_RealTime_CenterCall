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

export type RealtimeSemanticResponseRequest = {
  callerTurnText: string;
  requestId?: string;
  purpose?: string;
  metadata?: Record<string, unknown>;
};

export type RealtimeToolResultRequest = {
  callId?: string;
  toolName?: string;
  output: unknown;
};

export type RealtimeFunctionToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RealtimeSessionPolicyUpdate = {
  instructions?: string;
  /**
   * Transitional bootstrap/default tool selection only.
   * Semantic one-tool enforcement must use setSemanticToolGate so the core does
   * not depend on any provider's session-level tool_choice representation.
   */
  toolChoice?: "AUTO" | "NONE";
  tools?: RealtimeFunctionToolDefinition[];
};

/** Provider-neutral command boundary for live conversational runtimes. */
export interface RealtimeProviderCommandPort {
  speak(request: RealtimeSpeechRequest): void;
  requestTextDecision(request: RealtimeTextDecisionRequest): void;
  createSemanticResponse(request: RealtimeSemanticResponseRequest): void;
  submitToolResult(request: RealtimeToolResultRequest): void;
  updateSessionPolicy(update: RealtimeSessionPolicyUpdate): void;
  setSemanticToolGate(armed: boolean): void;
  createDefaultResponse(): void;
  cancelResponse(responseId: string): void;
  clearPlayback(): void;
  clearInput(): void;
  discardInputItem(itemId: string): void;
  suspendInputDetection(): void;
  beginNonInterruptingListening(settings?: RealtimeInputDetectionSettings): void;
  restoreInputDetection(settings?: RealtimeInputDetectionSettings): void;
}
