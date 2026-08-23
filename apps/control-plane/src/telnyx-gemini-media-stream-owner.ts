export type TelnyxGeminiMediaStreamSnapshot = Readonly<{
  state: "NEW" | "READY" | "STOPPED" | "FAILED";
  streamId: string | null;
  nextChunk: number;
  bufferedChunks: number;
}>;

export type TelnyxGeminiMediaObservation = Readonly<{
  mediaPayloads: readonly string[];
  returnedMarks: readonly string[];
  stopped: boolean;
  snapshot: TelnyxGeminiMediaStreamSnapshot;
}>;

type TelnyxStreamMessage = {
  event?: unknown;
  stream_id?: unknown;
  start?: {
    media_format?: {
      encoding?: unknown;
      sample_rate?: unknown;
      channels?: unknown;
    };
  };
  media?: {
    track?: unknown;
    chunk?: unknown;
    payload?: unknown;
  };
  mark?: { name?: unknown };
  payload?: { code?: unknown; title?: unknown; detail?: unknown };
};

function parseMessage(data: unknown): TelnyxStreamMessage {
  let value = data;
  if (typeof data === "string") {
    try { value = JSON.parse(data); } catch { throw new Error("Invalid Telnyx media JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Telnyx media message");
  return value as TelnyxStreamMessage;
}

function positiveInteger(value: unknown, field: string): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Invalid Telnyx ${field}`);
  }
  return number;
}

/**
 * Owns the Telnyx half of the Gemini media ingress boundary.
 *
 * Telnyx documents that media events may arrive out of order and provides the
 * media.chunk identity for reordering. We therefore never order audio by arrival
 * time. Missing identities are buffered only within a bounded window; overflow
 * fails closed instead of guessing or using a timer.
 */
export class TelnyxGeminiMediaStreamOwner {
  private state: TelnyxGeminiMediaStreamSnapshot["state"] = "NEW";
  private streamId: string | null = null;
  private nextChunk = 1;
  private readonly buffered = new Map<number, string>();

  constructor(private readonly maxBufferedChunks = 64) {
    if (!Number.isInteger(maxBufferedChunks) || maxBufferedChunks < 1) {
      throw new Error("Telnyx media reorder window must be a positive integer");
    }
  }

  observe(data: unknown): TelnyxGeminiMediaObservation {
    if (this.state === "STOPPED" || this.state === "FAILED") {
      throw new Error(`Telnyx media owner is ${this.state.toLowerCase()}`);
    }
    const message = parseMessage(data);
    const event = typeof message.event === "string" ? message.event : "";
    const mediaPayloads: string[] = [];
    const returnedMarks: string[] = [];
    let stopped = false;

    if (event === "connected") return this.observation(mediaPayloads, returnedMarks, stopped);

    if (event === "start") {
      if (this.state !== "NEW") throw new Error("Telnyx media start is one-shot");
      const format = message.start?.media_format;
      if (format?.encoding !== "L16" || format.sample_rate !== 16000 || format.channels !== 1) {
        this.state = "FAILED";
        throw new Error("Telnyx Gemini media requires mono L16 at 16000 Hz");
      }
      if (typeof message.stream_id !== "string" || !message.stream_id.trim()) {
        this.state = "FAILED";
        throw new Error("Telnyx media start requires stream_id");
      }
      this.streamId = message.stream_id.trim();
      this.state = "READY";
      return this.observation(mediaPayloads, returnedMarks, stopped);
    }

    if (this.state !== "READY") throw new Error(`Telnyx media event ${event || "<missing>"} received before start`);
    if (typeof message.stream_id === "string" && message.stream_id.trim() !== this.streamId) {
      this.state = "FAILED";
      throw new Error("Telnyx media stream identity changed during call");
    }

    if (event === "media") {
      if (message.media?.track !== "inbound") return this.observation(mediaPayloads, returnedMarks, stopped);
      const chunk = positiveInteger(message.media.chunk, "media chunk");
      if (typeof message.media.payload !== "string" || !message.media.payload) throw new Error("Telnyx media payload is missing");
      if (chunk < this.nextChunk) return this.observation(mediaPayloads, returnedMarks, stopped);
      if (!this.buffered.has(chunk)) this.buffered.set(chunk, message.media.payload);
      if (this.buffered.size > this.maxBufferedChunks) {
        this.state = "FAILED";
        throw new Error(`Telnyx media reorder window exceeded while waiting for chunk ${this.nextChunk}`);
      }
      while (this.buffered.has(this.nextChunk)) {
        mediaPayloads.push(this.buffered.get(this.nextChunk)!);
        this.buffered.delete(this.nextChunk);
        this.nextChunk += 1;
      }
      return this.observation(mediaPayloads, returnedMarks, stopped);
    }

    if (event === "mark") {
      if (typeof message.mark?.name === "string" && message.mark.name.trim()) returnedMarks.push(message.mark.name.trim());
      return this.observation(mediaPayloads, returnedMarks, stopped);
    }

    if (event === "stop") {
      this.state = "STOPPED";
      this.buffered.clear();
      stopped = true;
      return this.observation(mediaPayloads, returnedMarks, stopped);
    }

    if (event === "error") {
      this.state = "FAILED";
      const code = message.payload?.code === undefined ? "unknown" : String(message.payload.code);
      const detail = typeof message.payload?.detail === "string" ? message.payload.detail : "Telnyx media error";
      throw new Error(`Telnyx media error ${code}: ${detail}`);
    }

    return this.observation(mediaPayloads, returnedMarks, stopped);
  }

  snapshot(): TelnyxGeminiMediaStreamSnapshot {
    return Object.freeze({
      state: this.state,
      streamId: this.streamId,
      nextChunk: this.nextChunk,
      bufferedChunks: this.buffered.size,
    });
  }

  private observation(
    mediaPayloads: readonly string[],
    returnedMarks: readonly string[],
    stopped: boolean,
  ): TelnyxGeminiMediaObservation {
    return Object.freeze({
      mediaPayloads: Object.freeze([...mediaPayloads]),
      returnedMarks: Object.freeze([...returnedMarks]),
      stopped,
      snapshot: this.snapshot(),
    });
  }
}
