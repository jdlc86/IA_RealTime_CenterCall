import { routeFastDiagnosticIngest, type FastDiagnosticIngestEnv } from "./fast-diagnostics-ingest";
import { routeFastGeminiPreflight, type FastGeminiPreflightEnv } from "./fast-preflight";
import { routeFastGeminiCanaryWebhook } from "./telnyx/fast-canary-route";
import { routeFastTransferAuthorize, routeFastTransferStart } from "./telnyx/fast-human-handoff";

type FastWorkerEnv = FastGeminiPreflightEnv & FastDiagnosticIngestEnv;

export default {
  async fetch(request: Request, env: FastWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "gemini-control-plane-fast",
        diagnosticsConfigured: Boolean(env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
      });
    }
    if (url.pathname === "/internal/preflight") return routeFastGeminiPreflight(request, env);
    if (url.pathname === "/internal/diagnostics-ingest") return routeFastDiagnosticIngest(request, env);
    if (url.pathname === "/internal/call-transfer/authorize") return routeFastTransferAuthorize(request, env);
    if (url.pathname === "/internal/call-transfer/start") return routeFastTransferStart(request, env);
    if (url.pathname === "/webhooks/telnyx/fast-canary") return routeFastGeminiCanaryWebhook(request, env);
    return new Response("not found", { status: 404 });
  },
};