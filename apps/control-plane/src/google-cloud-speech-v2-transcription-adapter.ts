import type {
  AuthoritativeCallerTranscriptionDelegate,
  AuthoritativeCallerTranscriptionRequest,
} from "./authoritative-caller-transcription-port.js";
import { swapPcm16Endianness } from "./gemini-telnyx-media-contract.js";

export type GoogleCloudSpeechV2TranscriptionOptions = Readonly<{
  projectId: string;
  location?: string;
  recognizer?: string;
  languageCodes: readonly string[];
  model?: string;
  accessTokenProvider: () => Promise<string>;
  fetcher?: typeof fetch;
}>;

type GoogleSpeechRecognizeResponse = {
  results?: Array<{
    alternatives?: Array<{ transcript?: unknown }>;
  }>;
};

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function canonicalSegment(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("?") || normalized.includes("#")) {
    throw new Error(`Google Cloud Speech ${field} is invalid`);
  }
  return normalized;
}

function canonicalLanguageCodes(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Google Cloud Speech requires at least one language code");
  }
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length !== values.length || new Set(normalized).size !== normalized.length) {
    throw new Error("Google Cloud Speech language codes are invalid");
  }
  return Object.freeze(normalized);
}

function pcm16BigEndianPayloadsToLinear16Content(payloads: readonly string[]): string {
  const converted: Uint8Array[] = [];
  let totalBytes = 0;
  for (const payload of payloads) {
    const source = decodeBase64(payload);
    if (source.byteLength === 0 || source.byteLength % 2 !== 0) {
      throw new Error("Google Cloud Speech requires complete PCM16 samples");
    }
    const littleEndian = swapPcm16Endianness(source);
    converted.push(littleEndian);
    totalBytes += littleEndian.byteLength;
  }
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of converted) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return encodeBase64(joined);
}

function transcriptFromResponse(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const response = value as GoogleSpeechRecognizeResponse;
  const parts: string[] = [];
  for (const result of response.results ?? []) {
    const transcript = result.alternatives?.[0]?.transcript;
    if (typeof transcript !== "string") continue;
    const normalized = transcript.replace(/\s+/g, " ").trim();
    if (normalized) parts.push(normalized);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Google Cloud Speech-to-Text v2 adapter for the authoritative transcription port.
 *
 * Input is the exact Telnyx-derived PCM16 big-endian candidate audio. Google
 * LINEAR16 requires headerless signed PCM16 little-endian, so byte order is
 * converted explicitly before the REST request. Authentication is injected and
 * never stored or surfaced by this adapter. No Gemini credential is reused.
 */
export class GoogleCloudSpeechV2TranscriptionAdapter implements AuthoritativeCallerTranscriptionDelegate {
  private readonly projectId: string;
  private readonly location: string;
  private readonly recognizer: string;
  private readonly languageCodes: readonly string[];
  private readonly model: string | null;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: GoogleCloudSpeechV2TranscriptionOptions) {
    this.projectId = canonicalSegment(options.projectId, "projectId");
    this.location = canonicalSegment(options.location ?? "global", "location");
    this.recognizer = canonicalSegment(options.recognizer ?? "_", "recognizer");
    this.languageCodes = canonicalLanguageCodes(options.languageCodes);
    this.model = options.model === undefined ? null : canonicalSegment(options.model, "model");
    this.fetcher = options.fetcher ?? fetch;
  }

  async transcribe(request: AuthoritativeCallerTranscriptionRequest): Promise<{ itemId: string; transcript: string }> {
    if (
      request.audio.encoding !== "PCM16_BE"
      || request.audio.sampleRateHz !== 16_000
      || request.audio.channels !== 1
      || request.audio.payloads.length === 0
    ) {
      throw new Error("Google Cloud Speech adapter requires mono PCM16 big-endian at 16000 Hz");
    }

    const content = pcm16BigEndianPayloadsToLinear16Content(request.audio.payloads);
    let token: string;
    try {
      token = (await this.options.accessTokenProvider()).trim();
    } catch {
      throw new Error("Google Cloud Speech access token acquisition failed");
    }
    if (!token) throw new Error("Google Cloud Speech access token is required");

    const config: Record<string, unknown> = {
      explicitDecodingConfig: {
        encoding: "LINEAR16",
        sampleRateHertz: 16_000,
        audioChannelCount: 1,
      },
      languageCodes: [...this.languageCodes],
    };
    if (this.model) config.model = this.model;

    const endpoint = `https://speech.googleapis.com/v2/projects/${encodeURIComponent(this.projectId)}/locations/${encodeURIComponent(this.location)}/recognizers/${encodeURIComponent(this.recognizer)}:recognize`;
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ config, content }),
      });
    } catch {
      throw new Error("Google Cloud Speech request failed");
    }
    if (!response.ok) {
      throw new Error(`Google Cloud Speech recognize failed with HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Google Cloud Speech returned invalid JSON");
    }
    const transcript = transcriptFromResponse(payload);
    if (!transcript) throw new Error("Google Cloud Speech returned no transcript");
    return { itemId: request.itemId, transcript };
  }
}
