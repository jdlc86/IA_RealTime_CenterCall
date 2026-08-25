const SAMPLE_RATE_HZ = 16_000;

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function decodePayload(payload) {
  const normalized = required(payload, "Gemini caller audio payload");
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0 || bytes.length % 2 !== 0) throw new Error("Gemini caller audio requires complete PCM16_LE samples");
  return { normalized, bytes };
}

function rmsPcm16Le(bytes) {
  let sumSquares = 0;
  const samples = bytes.length / 2;
  for (let offset = 0; offset < bytes.length; offset += 2) {
    const sample = bytes.readInt16LE(offset) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}

function samplesForMs(ms) { return Math.ceil((ms * SAMPLE_RATE_HZ) / 1000); }

export class TelnyxSampleCountVad {
  constructor(config) {
    if (!Number.isFinite(config?.startRms) || config.startRms <= 0 || config.startRms > 1) throw new Error("Gemini caller VAD startRms must be in (0,1]");
    if (!Number.isFinite(config?.stopRms) || config.stopRms < 0 || config.stopRms > config.startRms) throw new Error("Gemini caller VAD stopRms must be in [0,startRms]");
    if (!Number.isFinite(config?.minSpeechMs) || config.minSpeechMs <= 0) throw new Error("Gemini caller VAD minSpeechMs must be positive");
    if (!Number.isFinite(config?.minSilenceMs) || config.minSilenceMs <= 0) throw new Error("Gemini caller VAD minSilenceMs must be positive");
    this.config = Object.freeze({ ...config });
    this.minSpeechSamples = samplesForMs(config.minSpeechMs);
    this.minSilenceSamples = samplesForMs(config.minSilenceMs);
    this.reset();
  }

  observe(payload) {
    const { normalized, bytes } = decodePayload(payload);
    const sampleCount = bytes.length / 2;
    const rms = rmsPcm16Le(bytes);
    this.processedSamples += sampleCount;
    let boundary = null;
    let shouldBufferPayload = this.state === "SPEECH";

    if (this.state === "SILENCE") {
      if (rms >= this.config.startRms) {
        this.candidateSpeechSamples += sampleCount;
        this.onsetPayloads.push(normalized);
        if (this.candidateSpeechSamples >= this.minSpeechSamples) {
          this.state = "SPEECH";
          boundary = Object.freeze({ type: "SPEECH_START", replayPayloads: Object.freeze([...this.onsetPayloads]) });
          shouldBufferPayload = false;
          this.candidateSpeechSamples = 0;
          this.candidateSilenceSamples = 0;
          this.onsetPayloads = [];
        }
      } else {
        if (this.candidateSpeechSamples === 0) {
          this.noiseFloorRms = this.noiseFloorRms === null
            ? rms
            : (this.noiseFloorRms * 0.95) + (rms * 0.05);
        }
        this.candidateSpeechSamples = 0;
        this.onsetPayloads = [];
      }
    } else if (rms <= this.effectiveStopRms()) {
      this.candidateSilenceSamples += sampleCount;
      shouldBufferPayload = true;
      if (this.candidateSilenceSamples >= this.minSilenceSamples) {
        this.state = "SILENCE";
        this.candidateSilenceSamples = 0;
        boundary = Object.freeze({ type: "SPEECH_END" });
      }
    } else {
      this.candidateSilenceSamples = 0;
      shouldBufferPayload = true;
    }
    return Object.freeze({ boundary, shouldBufferPayload, rms, snapshot: this.snapshot() });
  }

  reset() {
    this.state = "SILENCE";
    this.candidateSpeechSamples = 0;
    this.candidateSilenceSamples = 0;
    this.processedSamples ??= 0;
    this.noiseFloorRms = null;
    this.onsetPayloads = [];
    return this.snapshot();
  }

  effectiveStopRms() {
    if (this.noiseFloorRms === null) return this.config.stopRms;
    return Math.min(this.config.startRms * 0.9, Math.max(this.config.stopRms, this.noiseFloorRms * 1.5));
  }

  snapshot() {
    return Object.freeze({ state: this.state, candidateSpeechSamples: this.candidateSpeechSamples, candidateSilenceSamples: this.candidateSilenceSamples, processedSamples: this.processedSamples, noiseFloorRms: this.noiseFloorRms, effectiveStopRms: this.effectiveStopRms() });
  }
}

/**
 * Owns one deferred caller candidate in the media plane until STT has produced
 * authoritative text and the control plane later resolves NORMAL/INTERRUPT/IGNORE.
 * Telnyx WebSocket L16 is PCM16 little-endian in the verified media-streaming
 * transport, so the exact payload is preserved for VAD, Google STT and Gemini.
 * No activityStart/audio/activityEnd is sent to Gemini from this component.
 */
export class AuthoritativeCallerInputOwner {
  constructor(transcribe, vadConfig, options = {}) {
    if (typeof transcribe !== "function") throw new Error("Gemini caller authoritative transcriber is required");
    this.transcribe = transcribe;
    this.vad = new TelnyxSampleCountVad(vadConfig);
    this.maxBufferedChunks = Number(options.maxBufferedChunks ?? 256);
    this.maxBufferedPayloadChars = Number(options.maxBufferedPayloadChars ?? 2_000_000);
    if (!Number.isSafeInteger(this.maxBufferedChunks) || this.maxBufferedChunks < 1) throw new Error("Gemini caller maxBufferedChunks is invalid");
    if (!Number.isSafeInteger(this.maxBufferedPayloadChars) || this.maxBufferedPayloadChars < 1) throw new Error("Gemini caller maxBufferedPayloadChars is invalid");
    this.sequence = 0;
    this.active = null;
    this.transcriptionInFlight = null;
    this.provisionalPlaybackResponseId = undefined;
    this.inputDetectionEnabled = true;
    this.revision = 0;
  }

  async observe(payload, playbackResponseId = null) {
    if (!this.inputDetectionEnabled) {
      return Object.freeze({ events: Object.freeze([]), snapshot: this.snapshot(), acoustic: null });
    }
    const before = this.vad.snapshot();
    const acoustic = this.vad.observe(payload);
    const after = acoustic.snapshot;
    const events = [];

    if (
      before.state === "SILENCE"
      && before.candidateSpeechSamples === 0
      && this.provisionalPlaybackResponseId === undefined
      && (after.candidateSpeechSamples > 0 || acoustic.boundary?.type === "SPEECH_START")
    ) {
      this.provisionalPlaybackResponseId = playbackResponseId || null;
    }

    if (acoustic.boundary?.type === "SPEECH_START") {
      if (this.active) throw new Error(`Gemini caller candidate already active: ${this.active.itemId}`);
      this.sequence += 1;
      this.active = {
        itemId: `gemini-candidate-${this.sequence}`,
        payloads: [],
        payloadChars: 0,
        transcript: null,
        playbackResponseIdAtStart: this.provisionalPlaybackResponseId === undefined ? (playbackResponseId || null) : this.provisionalPlaybackResponseId,
      };
      this.provisionalPlaybackResponseId = undefined;
      events.push(Object.freeze({ type: "CALLER_SPEECH_STARTED", itemId: this.active.itemId, playbackResponseIdAtStart: this.active.playbackResponseIdAtStart }));
      for (const onset of acoustic.boundary.replayPayloads) this.buffer(onset);
    } else if (acoustic.shouldBufferPayload && this.active) {
      this.buffer(payload);
    } else if (
      after.state === "SILENCE"
      && after.candidateSpeechSamples === 0
      && !this.active
    ) {
      this.provisionalPlaybackResponseId = undefined;
    }

    if (acoustic.boundary?.type === "SPEECH_END") {
      const candidate = this.requireActive();
      if (this.transcriptionInFlight) throw new Error(`Gemini caller transcription already in flight: ${this.transcriptionInFlight}`);
      const flight = Object.freeze({ itemId: candidate.itemId, revision: this.revision });
      this.transcriptionInFlight = flight;
      try {
        const exactPayloads = Object.freeze([...candidate.payloads]);
        const evidence = await this.transcribe({ itemId: candidate.itemId, payloads: exactPayloads });
        if (this.revision !== flight.revision || !this.inputDetectionEnabled) {
          return Object.freeze({ events: Object.freeze([]), snapshot: this.snapshot(), acoustic: Object.freeze({ rms: acoustic.rms, vad: acoustic.snapshot }) });
        }
        if (!this.active || this.active.itemId !== candidate.itemId) throw new Error(`Gemini caller transcription became stale: ${candidate.itemId}`);
        if (required(evidence?.itemId, "Gemini caller transcript item id") !== candidate.itemId) throw new Error(`Gemini caller transcript identity mismatch: expected ${candidate.itemId}`);
        const transcript = required(evidence?.transcript, "Gemini caller authoritative transcript").replace(/\s+/g, " ").trim();
        candidate.transcript = transcript;
        events.push(Object.freeze({ type: "CALLER_SPEECH_STOPPED", itemId: candidate.itemId }));
        events.push(Object.freeze({ type: "CALLER_TRANSCRIPT_COMPLETED", itemId: candidate.itemId, transcript, playbackResponseIdAtStart: candidate.playbackResponseIdAtStart }));
      } catch (error) {
        if (this.active?.itemId === candidate.itemId) this.active = null;
        this.provisionalPlaybackResponseId = undefined;
        this.vad.reset();
        throw error;
      } finally {
        if (this.transcriptionInFlight === flight) this.transcriptionInFlight = null;
      }
    }
    return Object.freeze({ events: Object.freeze(events), snapshot: this.snapshot(), acoustic: Object.freeze({ rms: acoustic.rms, vad: acoustic.snapshot }) });
  }

  resolve(itemId, decision) {
    const candidate = this.requireMatching(itemId);
    if (!candidate.transcript) throw new Error(`Gemini caller candidate ${candidate.itemId} has no authoritative transcript`);
    if (!["NORMAL", "INTERRUPT", "IGNORE"].includes(decision)) throw new Error("Gemini caller decision is invalid");
    const result = Object.freeze({ itemId: candidate.itemId, transcript: candidate.transcript, mediaPayloads: Object.freeze([...candidate.payloads]), playbackResponseIdAtStart: candidate.playbackResponseIdAtStart, decision });
    this.active = null;
    this.provisionalPlaybackResponseId = undefined;
    this.vad.reset();
    return result;
  }

  clear() {
    this.revision += 1;
    this.active = null;
    this.provisionalPlaybackResponseId = undefined;
    this.vad.reset();
    return this.snapshot();
  }

  suspend() {
    this.inputDetectionEnabled = false;
    return this.clear();
  }

  restore() {
    this.inputDetectionEnabled = true;
    this.vad.reset();
    return this.snapshot();
  }

  buffer(payload) {
    const candidate = this.requireActive();
    if (candidate.transcript) throw new Error(`Gemini caller candidate ${candidate.itemId} is already completed`);
    const normalized = required(payload, "Gemini caller candidate payload");
    if (candidate.payloads.length >= this.maxBufferedChunks) throw new Error(`Gemini caller candidate ${candidate.itemId} exceeded buffered chunk limit`);
    const next = candidate.payloadChars + normalized.length;
    if (next > this.maxBufferedPayloadChars) throw new Error(`Gemini caller candidate ${candidate.itemId} exceeded buffered payload limit`);
    candidate.payloads.push(normalized);
    candidate.payloadChars = next;
  }

  requireActive() { if (!this.active) throw new Error("Gemini caller candidate is not active"); return this.active; }
  requireMatching(itemId) { const candidate = this.requireActive(); const normalized = required(itemId, "Gemini caller item id"); if (normalized !== candidate.itemId) throw new Error(`Gemini caller candidate identity mismatch: expected ${candidate.itemId}`); return candidate; }
  snapshot() { return Object.freeze({ activeItemId: this.active?.itemId ?? null, sequence: this.sequence, bufferedChunks: this.active?.payloads.length ?? 0, bufferedPayloadChars: this.active?.payloadChars ?? 0, transcriptReady: Boolean(this.active?.transcript), transcriptionInFlightItemId: this.transcriptionInFlight?.itemId ?? null, provisionalPlaybackResponseId: this.provisionalPlaybackResponseId ?? null, inputDetectionEnabled: this.inputDetectionEnabled }); }
}
