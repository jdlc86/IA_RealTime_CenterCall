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
   * Legacy/bootstrap compatibility only. Current semantic one-tool enforcement
   * must use setSemanticToolGate so provider-specific tool-choice wire semantics
   * do not leak into the modern core. REQUIRED remains accepted while inherited
   * pre-v17 layers are migrated behind the neutral gate.
   */
  toolChoice?: "AUTO" | "NONE" | "REQUIRED";
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
