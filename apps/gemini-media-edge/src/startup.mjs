import process from "node:process";
import { runGeminiLiveControlSpeechProbe } from "./live-control-speech-probe.mjs";

const result = await runGeminiLiveControlSpeechProbe({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_LIVE_MODEL,
  voiceName: process.env.GEMINI_LIVE_VOICE ?? "Kore",
});

const message = Object.freeze({
  event: "gemini_control_speech_readiness",
  ...result,
});

if (result.status !== "ready") {
  console.error(JSON.stringify(message));
  throw new Error(`Gemini native control speech readiness failed: ${result.failureCategory ?? "UNKNOWN"}`);
}

console.log(JSON.stringify(message));
await import("./server.mjs");
