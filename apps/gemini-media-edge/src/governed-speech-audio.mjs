function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

/**
 * Resolves an already-authorized governed speech command into exact PCM16 audio.
 * This function owns no sockets and no playback state; it only validates the TTS
 * result before runtime code is allowed to enqueue it for correlated Telnyx playout.
 */
export async function prepareGovernedSpeechAudio(synthesize, command) {
  if (typeof synthesize !== "function") throw new Error("Governed speech synthesizer is required");
  const responseId = required(command?.responseId, "Governed speech response id");
  const text = required(command?.text, "Governed speech text");
  const result = await synthesize({ text });
  if (!result || typeof result !== "object") throw new Error("Governed speech synthesizer returned an invalid result");
  if (result.encoding !== "PCM16_LE") throw new Error("Governed speech synthesizer returned unsupported encoding");
  if (result.sampleRateHertz !== 16_000) throw new Error("Governed speech synthesizer returned unsupported sample rate");
  if (!Buffer.isBuffer(result.pcm16le) || result.pcm16le.length === 0 || result.pcm16le.length % 2 !== 0) {
    throw new Error("Governed speech synthesizer returned invalid PCM16 audio");
  }
  return Object.freeze({ responseId, text, pcm16le: Buffer.from(result.pcm16le) });
}
