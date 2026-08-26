import { routeAuthenticatedGeminiControlV1 } from "./control-auth/route-v1";
import type { GeminiControlPlaneEnv } from "./gemini-call-session";
import { routeFastGeminiCanaryWebhook, type FastGeminiCanaryEnv } from "./telnyx/fast-canary-route";
export { GeminiCallSession } from "./gemini-call-session";

type GeminiWorkerEnv = GeminiControlPlaneEnv & FastGeminiCanaryEnv & Readonly<{
  GEMINI_CONTROL_CAPABILITY_SECRET: string;
}>;

export default {
  async fetch(request: Request, env: GeminiWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "gemini-control-plane-probe" });
    }
    if (url.pathname === "/webhooks/telnyx/fast-canary") {
      return routeFastGeminiCanaryWebhook(request, env);
    }
    if (url.pathname !== "/internal/control") return new Response("not found", { status: 404 });
    return routeAuthenticatedGeminiControlV1(request, env);
  },
};
