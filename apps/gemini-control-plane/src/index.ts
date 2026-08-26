import type { GeminiControlPlaneEnv } from "./gemini-call-session";
export { GeminiCallSession } from "./gemini-call-session";

function requiredId(value: string | null, name: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > 160 || /[\r\n\t]/.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

export default {
  async fetch(request: Request, env: GeminiControlPlaneEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "gemini-control-plane-probe" });
    }
    if (url.pathname !== "/internal/control") return new Response("not found", { status: 404 });

    let callSessionId: string;
    try { callSessionId = requiredId(url.searchParams.get("call_session_id"), "call_session_id"); }
    catch { return new Response("invalid control identity", { status: 400 }); }

    const stub = env.GEMINI_CALL_SESSIONS.getByName(callSessionId);
    return stub.fetch(request);
  },
};
