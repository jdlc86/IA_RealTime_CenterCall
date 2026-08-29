import { routeFastDiagnosticIngest, type FastDiagnosticIngestEnv } from "./fast-diagnostics-ingest";
import { routeFastGeminiPreflight, type FastGeminiPreflightEnv } from "./fast-preflight";
import { routeFastAuthoritativeDateTime, type FastTemporalAuthorityEnv } from "./fast-temporal-authority";
import {
  isQueuedFastCallerSecuritySignal,
  persistFastCallerSecuritySignal,
  type FastCallerSecurityEnv,
  type QueuedFastCallerSecuritySignal,
} from "./fast-caller-security";
import { routeFastSemanticSecuritySignal, type FastSemanticSecuritySignalEnv } from "./fast-semantic-security-signal";
import { routeFastGeminiCanaryWebhook } from "./telnyx/fast-canary-route";
import { routeFastTransferAuthorize, routeFastTransferStart } from "./telnyx/fast-human-handoff";

type FastWorkerEnv = FastGeminiPreflightEnv & FastDiagnosticIngestEnv & FastTemporalAuthorityEnv
  & FastCallerSecurityEnv & FastSemanticSecuritySignalEnv;

async function consumeCallerSecuritySignals(
  batch: MessageBatch<QueuedFastCallerSecuritySignal>,
  env: FastWorkerEnv,
): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    if (!isQueuedFastCallerSecuritySignal(message.body)) {
      console.error(JSON.stringify({ level: "error", event: "gemini_caller_security_signal_queue_invalid", queue_message_id: message.id }));
      message.ack();
      return;
    }
    try {
      await persistFastCallerSecuritySignal(env, message.body);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "gemini_caller_security_signal_queue_retry",
        queue_message_id: message.id,
        event_key: message.body.eventKey,
        attempts: message.attempts,
        error: error instanceof Error ? error.message : String(error),
      }));
      message.retry();
    }
  }));
}

export default {
  async fetch(request: Request, env: FastWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const handoffAudit = { waitUntil: (promise: Promise<void>) => ctx.waitUntil(promise) };
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "gemini-control-plane-fast",
        diagnosticsConfigured: Boolean(env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
      });
    }
    if (url.pathname === "/internal/preflight") return routeFastGeminiPreflight(request, env);
    if (url.pathname === "/internal/diagnostics-ingest") return routeFastDiagnosticIngest(request, env);
    if (url.pathname === "/internal/fast-semantic-security-signal") {
      return routeFastSemanticSecuritySignal(request, env);
    }
    if (url.pathname === "/internal/authoritative-datetime") return routeFastAuthoritativeDateTime(request, env);
    if (url.pathname === "/internal/call-transfer/authorize") return routeFastTransferAuthorize(request, env, handoffAudit);
    if (url.pathname === "/internal/call-transfer/start") return routeFastTransferStart(request, env, handoffAudit);
    if (url.pathname === "/webhooks/telnyx/fast-canary") return routeFastGeminiCanaryWebhook(request, env, { handoffAudit });
    return new Response("not found", { status: 404 });
  },
  async queue(batch: MessageBatch<QueuedFastCallerSecuritySignal>, env: FastWorkerEnv): Promise<void> {
    await consumeCallerSecuritySignals(batch, env);
  },
};
