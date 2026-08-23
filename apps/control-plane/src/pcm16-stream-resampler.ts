export type Pcm16Resampler = {
  push(samples: Int16Array): Int16Array;
  reset(): void;
};

function clampPcm16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

/**
 * Streaming 24 kHz -> 16 kHz PCM16 resampler.
 *
 * The 2:3 conversion is stateful across arbitrary provider chunk boundaries. It
 * uses linear interpolation as a deliberately small edge implementation for the
 * synthetic G3 bridge. Audio-output capability remains false until real media E2E
 * validates quality; this class must not be treated as proof of production audio.
 */
export class Pcm16LinearResampler24To16 implements Pcm16Resampler {
  private pending: number[] = [];
  private nextSourcePosition = 0;

  push(samples: Int16Array): Int16Array {
    if (samples.length === 0) return new Int16Array(0);
    for (const sample of samples) this.pending.push(sample);

    const output: number[] = [];
    const sourceStep = 24_000 / 16_000;
    while (Math.floor(this.nextSourcePosition) + 1 < this.pending.length) {
      const leftIndex = Math.floor(this.nextSourcePosition);
      const fraction = this.nextSourcePosition - leftIndex;
      const left = this.pending[leftIndex];
      const right = this.pending[leftIndex + 1];
      output.push(clampPcm16(left + (right - left) * fraction));
      this.nextSourcePosition += sourceStep;
    }

    const consumed = Math.floor(this.nextSourcePosition);
    if (consumed > 0) {
      this.pending.splice(0, consumed);
      this.nextSourcePosition -= consumed;
    }

    return Int16Array.from(output);
  }

  reset(): void {
    this.pending = [];
    this.nextSourcePosition = 0;
  }
}
