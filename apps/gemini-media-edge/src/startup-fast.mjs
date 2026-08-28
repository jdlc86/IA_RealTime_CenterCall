import process from "node:process";
import { createFastDiagnosticFlusher } from "./fast-diagnostic-flush.mjs";
import { runFastGeminiLiveProbe } from "./fast-live-probe.mjs";
import { createFastGeminiMediaServerFromEnv } from "./server-fast.mjs";
import { createFastSecurityControlClient } from "./fast-security-control.mjs";
import {
  FAST_SEMANTIC_SECURITY_TOOL_NAME,
  createFastSemanticSecurityBoundaryHandler,
} from "./fast-semantic-security-boundary.mjs";

const DEFAULT_DIAGNOSTIC_SINK_URL = "https://ia-realtime-centercall-gemini-fast.julopezcardona.workers.dev/internal/diagnostics-ingest";
const DEFAULT_SECURITY_CONTROL_URL = "https://ia-realtime-centercall.julopezcardona.workers.dev";
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
const diagnosticSinkUrl = process.env.FAST_DIAGNOSTIC_SINK_URL || DEFAULT_DIAGNOSTIC_SINK_URL;
const flushDiagnostics = createFastDiagnosticFlusher({
  sinkUrl: diagnosticSinkUrl,
  controlToken: process.env.MEDIA_EDGE_CONTROL_PLANE_TOKEN,
});
const securityControl = createFastSecurityControlClient({
  baseUrl: process.env.FAST_SECURITY_CONTROL_URL || DEFAULT_SECURITY_CONTROL_URL,
  controlToken: process.env.MEDIA_EDGE_CONTROL_PLANE_TOKEN,
});
const semanticSecurityHandler = createFastSemanticSecurityBoundaryHandler({
  recordSemanticIncident: securityControl.recordSemanticIncident,
});
const port = Number(process.env.PORT ?? "8080");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");
const runtime = createFastGeminiMediaServerFromEnv(process.env, {
  providerReadiness,
  flushDiagnostics,
  toolHandlers: Object.freeze({
    [FAST_SEMANTIC_SECURITY_TOOL_NAME]: semanticSecurityHandler,
  }),
});
runtime.server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({
    event: "gemini_fast_media_ready",
    port,
    model,
    mediaPath: runtime.mediaPath,
    providerSetupMs: providerReadiness.setupMs,
    providerFirstAudioMs: providerReadiness.firstAudioMs,
    diagnostics: "post_call_async",
  }));
});

const shutdown = async () => {
  await runtime.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
