import { routeFastGeminiCanaryWebhook, type FastGeminiCanaryEnv } from "./telnyx/fast-canary-route";

export default {
  async fetch(request: Request, env: FastGeminiCanaryEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "gemini-control-plane-fast" });
    }
    if (url.pathname === "/webhooks/telnyx/fast-canary") {
      return routeFastGeminiCanaryWebhook(request, env);
    }
    return new Response("not found", { status: 404 });
  },
};
