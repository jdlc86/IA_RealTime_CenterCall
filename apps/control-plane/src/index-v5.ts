import baseHandler from "./index-v4";
export { CallSession } from "./call-session-v46-sideband-lifecycle";

type WorkerEnv = {
  CALL_SESSIONS: DurableObjectNamespace;
};

type HandoffTransportContext = {
  realtimeCallId: string;
  telnyxCallControlId: string;
  calledNumber: string;
};

function getSipHeader(headers: Array<{ name?: unknown; value?: unknown }>, name: string): string | null {
  const normalized = name.toLowerCase();
  for (const header of headers) {
    if (typeof header.name === "string" && header.name.toLowerCase() === normalized && typeof header.value === "string" && header.value.trim()) {
      return header.value.trim();
    }
  }
  return null;
}

async function inspectHandoffTransportContext(request: Request): Promise<HandoffTransportContext | null> {
  let event: unknown;
  try { event = JSON.parse(await request.text()); } catch { return null; }
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const record = event as { type?: unknown; data?: unknown };
  if (record.type !== "realtime.call.incoming" || !record.data || typeof record.data !== "object" || Array.isArray(record.data)) return null;
  const data = record.data as { call_id?: unknown; sip_headers?: unknown };
  if (typeof data.call_id !== "string" || !data.call_id.trim() || !Array.isArray(data.sip_headers)) return null;
  const headers = data.sip_headers.filter((item): item is { name?: unknown; value?: unknown } => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const telnyxCallControlId = getSipHeader(headers, "x-ia-telnyx-call-control-id");
  const calledNumber = getSipHeader(headers, "x-ia-called-number");
  if (!telnyxCallControlId || !calledNumber) return null;
  return { realtimeCallId: data.call_id.trim(), telnyxCallControlId, calledNumber };
}

async function attachHandoffTransportContext(env: WorkerEnv, context: HandoffTransportContext): Promise<void> {
  if (!env.CALL_SESSIONS || typeof env.CALL_SESSIONS.idFromName !== "function") throw new Error("CALL_SESSIONS binding unavailable");
  const stub = env.CALL_SESSIONS.get(env.CALL_SESSIONS.idFromName(context.realtimeCallId));
  const response = await stub.fetch("https://call-session.internal/human-handoff/context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      realtime_call_id: context.realtimeCallId,
      telnyx_call_control_id: context.telnyxCallControlId,
      called_number: context.calledNumber,
    }),
  });
  if (!response.ok) throw new Error(`Human handoff transport context failed with HTTP ${response.status}`);
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks/openai") {
      const inspected = inspectHandoffTransportContext(request.clone());
      const response = await baseHandler.fetch(request, env as never, ctx);
      const context = await inspected;
      if (response.ok && context) {
        try { await attachHandoffTransportContext(env, context); }
        catch (error) {
          console.error(JSON.stringify({
            level: "error",
            event: "human_handoff_transport_context_attach_failed",
            call_id: context.realtimeCallId,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
      return response;
    }
    return baseHandler.fetch(request, env as never, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
