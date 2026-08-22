import baseHandler from "./index-v5";
import { CallerSecurityService, type QueuedCallerSecuritySignal } from "./caller-security.js";
// Runtime chain now ends at V54. Governed post-tool speech liveness is composed
// through governed-speech-liveness-coordinator instead of a V55 subclass.
export { CallSession } from "./call-session-v54-close-confirmation-authority";

type WorkerEnv = Env & {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  CALLER_SECURITY_SIGNALS: Queue<QueuedCallerSecuritySignal>;
};

function isQueuedSecuritySignal(value: unknown): value is QueuedCallerSecuritySignal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<QueuedCallerSecuritySignal>;
  return typeof item.eventKey === "string" && Boolean(item.eventKey.trim())
    && typeof item.tenantId === "string" && Boolean(item.tenantId.trim())
    && typeof item.callerKey === "string" && Boolean(item.callerKey.trim())
    && typeof item.eventType === "string" && Boolean(item.eventType.trim())
    && ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(item.severity ?? "")
    && typeof item.riskDelta === "number" && Number.isInteger(item.riskDelta) && item.riskDelta >= 0
    && typeof item.highConfidence === "boolean"
    && (item.metadata === undefined || (Boolean(item.metadata) && typeof item.metadata === "object" && !Array.isArray(item.metadata)));
}

async function consumeSecuritySignals(batch: MessageBatch<QueuedCallerSecuritySignal>, env: WorkerEnv): Promise<void> {
  const security = new CallerSecurityService(env);
  await Promise.all(batch.messages.map(async (message) => {
    if (!isQueuedSecuritySignal(message.body)) {
      console.error(JSON.stringify({ level: "error", event: "caller_security_signal_queue_invalid", queue_message_id: message.id }));
      message.ack();
      return;
    }
    try {
      await security.recordSignalByCallerKey(message.body);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "caller_security_signal_queue_retry",
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
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    if (!baseHandler.fetch) return new Response("Worker fetch handler unavailable", { status: 503 });
    return baseHandler.fetch(request, env as never, ctx);
  },
  queue: consumeSecuritySignals,
} satisfies ExportedHandler<WorkerEnv, QueuedCallerSecuritySignal>;
