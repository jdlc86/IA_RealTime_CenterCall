export type AuthoritativeCallerAudio = Readonly<{
  encoding: "L16";
  sampleRateHz: 16_000;
  channels: 1;
  payloads: readonly string[];
}>;

export type AuthoritativeCallerTranscriptionRequest = Readonly<{
  itemId: string;
  audio: AuthoritativeCallerAudio;
}>;

export type AuthoritativeCallerTranscriptEvidence = Readonly<{
  itemId: string;
  transcript: string;
  audio: AuthoritativeCallerAudio;
}>;

export interface AuthoritativeCallerTranscriptionDelegate {
  transcribe(request: AuthoritativeCallerTranscriptionRequest): Promise<{
    itemId: string;
    transcript: string;
  }>;
}

export interface AuthoritativeCallerTranscriptionPort {
  transcribe(request: AuthoritativeCallerTranscriptionRequest): Promise<AuthoritativeCallerTranscriptEvidence>;
}

const VERIFIED_TRANSCRIPTS = new WeakSet<object>();

function normalizeRequest(request: AuthoritativeCallerTranscriptionRequest): AuthoritativeCallerTranscriptionRequest {
  const itemId = request.itemId.trim();
  if (!itemId) throw new Error("Authoritative caller transcription requires itemId");
  if (request.audio.encoding !== "L16" || request.audio.sampleRateHz !== 16_000 || request.audio.channels !== 1) {
    throw new Error("Authoritative caller transcription requires mono L16 at 16000 Hz");
  }
  if (!Array.isArray(request.audio.payloads) || request.audio.payloads.length === 0) {
    throw new Error("Authoritative caller transcription requires buffered audio");
  }
  const payloads = request.audio.payloads.map((payload) => payload.trim());
  if (payloads.some((payload) => !payload)) {
    throw new Error("Authoritative caller transcription rejects empty audio payloads");
  }
  return Object.freeze({
    itemId,
    audio: Object.freeze({
      encoding: "L16" as const,
      sampleRateHz: 16_000 as const,
      channels: 1 as const,
      payloads: Object.freeze(payloads),
    }),
  });
}

/**
 * Validate one external STT boundary without embedding a vendor in the core.
 *
 * The delegate is the only place allowed to contact an eventual transcription
 * provider. This wrapper enforces exact candidate identity, non-empty transcript
 * evidence, immutable audio input and one explicit PCM contract. The resulting
 * evidence carries the exact canonical audio that was submitted, so downstream
 * ownership can prove the transcript belongs to the buffered candidate rather
 * than merely sharing its item id. It uses no Gemini Live transcript chunks,
 * timers or model turn-completion signals.
 */
export function createAuthoritativeCallerTranscriptionPort(
  delegate: AuthoritativeCallerTranscriptionDelegate,
): AuthoritativeCallerTranscriptionPort {
  return Object.freeze({
    async transcribe(request: AuthoritativeCallerTranscriptionRequest): Promise<AuthoritativeCallerTranscriptEvidence> {
      const normalized = normalizeRequest(request);
      const result = await delegate.transcribe(normalized);
      const itemId = typeof result?.itemId === "string" ? result.itemId.trim() : "";
      const transcript = typeof result?.transcript === "string"
        ? result.transcript.replace(/\s+/g, " ").trim()
        : "";
      if (!itemId || itemId !== normalized.itemId) {
        throw new Error(`Authoritative caller transcription identity mismatch: expected ${normalized.itemId}`);
      }
      if (!transcript) throw new Error("Authoritative caller transcription returned empty transcript");
      const evidence = Object.freeze({
        itemId,
        transcript,
        audio: normalized.audio,
      });
      VERIFIED_TRANSCRIPTS.add(evidence);
      return evidence;
    },
  });
}

export function requireAuthoritativeCallerTranscriptEvidence(
  value: unknown,
): AuthoritativeCallerTranscriptEvidence {
  if (!value || typeof value !== "object" || !VERIFIED_TRANSCRIPTS.has(value)) {
    throw new Error("Caller transcript is not authoritative transcription evidence");
  }
  return value as AuthoritativeCallerTranscriptEvidence;
}
