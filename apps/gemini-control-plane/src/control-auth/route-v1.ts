import {
  bearerTokenFromRequest,
  GEMINI_CONTROL_CAPABILITY_VERSION_V1,
  verifyGeminiControlCapabilityV1,
} from "./capability-v1";

export type GeminiControlRouteEnv = Readonly<{
  GEMINI_CONTROL_CAPABILITY_SECRET: string;
  GEMINI_CALL_SESSIONS: Readonly<{
    getByName(name: string): Readonly<{
      fetch(request: Request): Response | Promise<Response>;
    }>;
  }>;
}>;

const LEGACY_IDENTITY_QUERY_PARAMS = ["call_session_id", "edge_session_id", "credential_id"] as const;

function requiredSecret(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing runtime configuration: GEMINI_CONTROL_CAPABILITY_SECRET");
  return value.trim();
}

function internalControlRequest(request: Request, claims: Awaited<ReturnType<typeof verifyGeminiControlCapabilityV1>>): Request {
  if (!claims) throw new Error("Gemini control capability claims are required");
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.set("x-gemini-control-authenticated", GEMINI_CONTROL_CAPABILITY_VERSION_V1);
  headers.set("x-gemini-tenant-id", claims.tenantId);
  headers.set("x-gemini-call-control-id", claims.callControlId);
  headers.set("x-gemini-call-session-id", claims.callSessionId);
  headers.set("x-gemini-edge-session-id", claims.edgeSessionId);
  headers.set("x-gemini-credential-id", claims.credentialId);
  headers.set("x-gemini-capability-not-after", String(claims.notAfterEpochMs));

  return new Request("https://gemini-call-session.internal/internal/control", {
    method: request.method,
    headers,
  });
}

/**
 * Public WSS authentication boundary. The caller presents only an opaque
 * capability in Authorization. Immutable call/edge bindings are recovered
 * from verified claims and forwarded to the Durable Object through internal
 * headers; credentials never need to appear in the public URL.
 */
export async function routeAuthenticatedGeminiControlV1(
  request: Request,
  env: GeminiControlRouteEnv,
  nowEpochMs = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  if (LEGACY_IDENTITY_QUERY_PARAMS.some((name) => url.searchParams.has(name))) {
    return new Response("control identity must use bearer capability", { status: 400 });
  }

  const token = bearerTokenFromRequest(request);
  if (!token) return new Response("missing control capability", { status: 401 });

  const claims = await verifyGeminiControlCapabilityV1(
    token,
    requiredSecret(env.GEMINI_CONTROL_CAPABILITY_SECRET),
    nowEpochMs,
  );
  if (!claims) return new Response("invalid control capability", { status: 403 });

  const stub = env.GEMINI_CALL_SESSIONS.getByName(claims.callSessionId);
  return stub.fetch(internalControlRequest(request, claims));
}
