import { routeFastGeminiPreflight, type FastGeminiPreflightEnv } from "./fast-preflight";
import { routeFastGeminiCanaryWebhook } from "./telnyx/fast-canary-route";

export default {
  async fetch(request: Request, env: FastGeminiPreflightEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "gemini-control-plane-fast" });
    }
    if (url.pathname === "/internal/preflight") {
      return routeFastGeminiPreflight(request, env);
    }
    if (url.pathname === "/webhooks/telnyx/fast-canary") {
      return routeFastGeminiCanaryWebhook(request, env);
    }
    return new Response("not found", { status: 404 });
  },
};
