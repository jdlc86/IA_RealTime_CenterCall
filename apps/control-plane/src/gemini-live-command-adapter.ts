import type {
  RealtimeProviderCommandPort,
  RealtimeSemanticResponseRequest,
  RealtimeSessionPolicyUpdate,
  RealtimeSpeechRequest,
  RealtimeTextDecisionRequest,
  RealtimeToolResultRequest,
} from "./realtime-provider-command-port";

export type GeminiLiveCommandHost = {
  send(message: Record<string, unknown>): void;
};

export type GeminiLiveInitialSetup = {
  model: string;
  instructions?: string;
  tools?: RealtimeSessionPolicyUpdate["tools"];
  responseModalities?: readonly ("AUDIO" | "TEXT")[];
  enableInputTranscription?: boolean;
  enableOutputTranscription?: boolean;
  manualActivityDetection?: boolean;
};

function functionDeclarations(tools: RealtimeSessionPolicyUpdate["tools"]): Record<string, unknown>[] | undefined {
  if (tools === undefined) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * Build the one immutable Gemini Live setup message.
 *
 * The Live protocol accepts setup only as the first client message. Runtime
 * session policy mutations are therefore deliberately NOT translated here.
 */
export function buildGeminiLiveInitialSetup(request: GeminiLiveInitialSetup): Record<string, unknown> {
  const setup: Record<string, unknown> = { model: request.model };
  if (request.instructions !== undefined) {
    setup.systemInstruction = { parts: [{ text: request.instructions }] };
  }
  const declarations = functionDeclarations(request.tools);
  if (declarations !== undefined) setup.tools = [{ functionDeclarations: declarations }];
  if (request.responseModalities !== undefined) {
    setup.generationConfig = { responseModalities: [...request.responseModalities] };
  }
  if (request.enableInputTranscription) setup.inputAudioTranscription = {};
  if (request.enableOutputTranscription) setup.outputAudioTranscription = {};
  if (request.manualActivityDetection) {
    setup.realtimeInputConfig = {
      automaticActivityDetection: { disabled: true },
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
    };
  }
  return { setup };
}

function unsupported(operation: string, gate: string): never {
  throw new Error(`Gemini Live ${operation} has no proven neutral mapping before ${gate}`);
}

/**
 * G2 edge adapter for protocol operations whose semantics are already proven.
 *
 * Only function responses are enabled here. OpenAI response-local speech,
 * isolated text decisions, dynamic session updates and response.create-style
 * continuation do not have equivalent Gemini Live semantics and therefore fail
 * closed instead of being disguised as realtime user input.
 */
export class GeminiLiveCommandAdapter implements RealtimeProviderCommandPort {
  private readonly host: GeminiLiveCommandHost;

  constructor(host: GeminiLiveCommandHost) {
    this.host = host;
  }

  speak(_request: RealtimeSpeechRequest): void {
    unsupported("governed speech", "G3/G4 response lifecycle conformance");
  }

  requestTextDecision(_request: RealtimeTextDecisionRequest): void {
    unsupported("isolated text decision", "a dedicated semantic-decision capability");
  }

  createSemanticResponse(_request: RealtimeSemanticResponseRequest): void {
    unsupported("synthetic semantic response", "G3 caller-input ownership conformance");
  }

  submitToolResult(request: RealtimeToolResultRequest): void {
    if (!request.callId || !request.toolName) {
      throw new Error("Gemini Live tool responses require callId and toolName");
    }
    this.host.send({
      toolResponse: {
        functionResponses: [{
          id: request.callId,
          name: request.toolName,
          response: { result: request.output },
        }],
      },
    });
  }

  updateSessionPolicy(_update: RealtimeSessionPolicyUpdate): void {
    unsupported("dynamic session policy update", "immutable setup composition");
  }

  setSemanticToolGate(_armed: boolean): void {
    unsupported("semantic tool gate", "provider-specific semantic gate conformance");
  }

  createDefaultResponse(): void {
    unsupported("default response creation", "G3/G4 turn continuation conformance");
  }

  cancelResponse(): void { unsupported("response cancellation", "G3/G4 media integration"); }
  clearPlayback(): void { unsupported("playback clearing", "G3 media integration"); }
  clearInput(): void { unsupported("input clearing", "G3 media integration"); }
  discardInputItem(): void { unsupported("item deletion", "G3/G4 conversation ownership conformance"); }
  suspendInputDetection(): void { unsupported("input detection control", "G4 conformance"); }
  beginNonInterruptingListening(): void { unsupported("input detection control", "G4 conformance"); }
  restoreInputDetection(): void { unsupported("input detection control", "G4 conformance"); }
}
