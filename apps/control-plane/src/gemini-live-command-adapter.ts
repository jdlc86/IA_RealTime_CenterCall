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

function functionDeclarations(update: RealtimeSessionPolicyUpdate): Record<string, unknown>[] | undefined {
  if (update.tools === undefined) return undefined;
  return update.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function textTurn(text: string): Record<string, unknown> {
  return {
    realtimeInput: {
      text,
    },
  };
}

/**
 * Gemini Live translation for G2 text/session/tool conformance.
 * Audio/VAD/playback commands intentionally fail closed until G3/G4 provide
 * provider-specific evidence instead of pretending OpenAI wire semantics exist.
 */
export class GeminiLiveCommandAdapter implements RealtimeProviderCommandPort {
  constructor(private readonly host: GeminiLiveCommandHost) {}

  speak(request: RealtimeSpeechRequest): void {
    const exact = request.exactText
      ? `\n\nTu salida completa debe ser exactamente ${JSON.stringify(request.exactText)}. No añadas nada.`
      : "";
    this.host.send(textTurn(`${request.instructions}${exact}`));
  }

  requestTextDecision(request: RealtimeTextDecisionRequest): void {
    this.host.send(textTurn(`${request.instructions}\n\nEntrada:\n${request.inputText}`));
  }

  createSemanticResponse(request: RealtimeSemanticResponseRequest): void {
    this.host.send(textTurn(request.callerTurnText));
  }

  submitToolResult(request: RealtimeToolResultRequest): void {
    if (!request.callId || !request.toolName) {
      throw new Error("Gemini Live tool responses require callId and toolName");
    }
    const response = typeof request.output === "string" ? { result: request.output } : { result: request.output };
    this.host.send({
      toolResponse: {
        functionResponses: [{
          id: request.callId,
          name: request.toolName,
          response,
        }],
      },
    });
  }

  updateSessionPolicy(update: RealtimeSessionPolicyUpdate): void {
    const setup: Record<string, unknown> = {};
    if (update.instructions !== undefined) {
      setup.systemInstruction = { parts: [{ text: update.instructions }] };
    }
    const declarations = functionDeclarations(update);
    if (declarations !== undefined) setup.tools = [{ functionDeclarations: declarations }];
    if (update.toolChoice !== undefined) {
      setup.toolConfig = {
        functionCallingConfig: {
          mode: update.toolChoice === "NONE" ? "NONE" : update.toolChoice === "REQUIRED" ? "ANY" : "AUTO",
        },
      };
    }
    this.host.send({ setup });
  }

  createDefaultResponse(): void {
    this.host.send(textTurn("Continúa la conversación de forma natural según el contexto actual."));
  }

  cancelResponse(): void { throw new Error("Gemini Live response cancellation requires G3/G4 media integration"); }
  clearPlayback(): void { throw new Error("Gemini Live playback clearing requires G3 media integration"); }
  clearInput(): void { throw new Error("Gemini Live input clearing requires G3 media integration"); }
  discardInputItem(): void { throw new Error("Gemini Live item deletion has no G2 conformance mapping"); }
  suspendInputDetection(): void { throw new Error("Gemini Live input detection control requires G4 conformance"); }
  beginNonInterruptingListening(): void { throw new Error("Gemini Live input detection control requires G4 conformance"); }
  restoreInputDetection(): void { throw new Error("Gemini Live input detection control requires G4 conformance"); }
}
