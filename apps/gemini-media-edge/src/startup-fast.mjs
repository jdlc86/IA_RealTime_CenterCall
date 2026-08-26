import process from "node:process";
import { runFastGeminiLiveProbe } from "./fast-live-probe.mjs";
import { createFastGeminiMediaServerFromEnv } from "./server-fast.mjs";

const model = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
const probe = await runFastGeminiLiveProbe({
  apiKey: process.env.GEMINI_API_KEY,
  model,
  voiceName: process.env.GEMINI_LIVE_VOICE || "Kore",
});
console.log(JSON.stringify({
  event: "gemini_fast_provider_readiness",
  ...probe,
}));
if (probe.status !== "ready") {
  throw new Error(`Gemini fast provider readiness failed: ${probe.failureCategory ?? "UNKNOWN"}`);
}

const providerReadiness = Object.freeze({
  setupMs: probe.setupMs,
  firstAudioMs: probe.firstAudioMs,
});
const port = Number(process.env.PORT ?? "8080");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");
const runtime = createFastGeminiMediaServerFromEnv(process.env, { providerReadiness });
runtime.server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({
    event: "gemini_fast_media_ready",
    port,
    model,
    mediaPath: runtime.mediaPath,
    providerSetupMs: providerReadiness.setupMs,
    providerFirstAudioMs: providerReadiness.firstAudioMs,
  }));
});

const shutdown = async () => {
  await runtime.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
