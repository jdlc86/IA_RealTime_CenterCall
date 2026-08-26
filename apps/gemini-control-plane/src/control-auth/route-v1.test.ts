import { describe, expect, it } from "vitest";
import {
  GEMINI_CONTROL_CAPABILITY_VERSION_V1,
  issueGeminiControlCapabilityV1,
  type GeminiControlCapabilityClaimsV1,
} from "./capability-v1";
import { routeAuthenticatedGeminiControlV1, type GeminiControlRouteEnv } from "./route-v1";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = 1_787_745_000_000;

function claims(overrides: Partial<GeminiControlCapabilityClaimsV1> = {}): GeminiControlCapabilityClaimsV1 {
  return {
    version: GEMINI_CONTROL_CAPABILITY_VERSION_V1,
    provider: "GEMINI",
    tenantId: "tenant-route",
    callControlId: "call-control-route",
    callSessionId: "call-session-route",
    edgeSessionId: "edge-session-route",
    credentialId: "credential-route",
    notAfterEpochMs: NOW + 60_000,
    ...overrides,
  };
}

function fakeEnv(capture: { name?: string; request?: Request }): GeminiControlRouteEnv {
  return {
    GEMINI_CONTROL_CAPABILITY_SECRET: SECRET,
    GEMINI_CALL_SESSIONS: {
      getByName(name: string) {
        capture.name = name;
        return {
          async fetch(request: Request) {
            capture.request = request;
            return new Response("forwarded", { status: 204 });
          },
        };
      },
    },
  };
}

describe("authenticated Gemini control route v1", () => {
  it("derives all internal bindings from a verified bearer capability", async () => {
    const capture: { name?: string; request?: Request } = {};
    const token = await issueGeminiControlCapabilityV1(claims(), SECRET);
    const request = new Request("https://worker/internal/control", {
      headers: { Authorization: `Bearer ${token}`, Upgrade: "websocket" },
    });

    const response = await routeAuthenticatedGeminiControlV1(request, fakeEnv(capture), NOW);
    expect(response.status).toBe(204);
    expect(capture.name).toBe("call-session-route");
    expect(capture.request?.url).toBe("https://gemini-call-session.internal/internal/control");
    expect(capture.request?.headers.get("authorization")).toBeNull();
    expect(capture.request?.headers.get("upgrade")).toBe("websocket");
    expect(capture.request?.headers.get("x-gemini-control-authenticated")).toBe(GEMINI_CONTROL_CAPABILITY_VERSION_V1);
    expect(capture.request?.headers.get("x-gemini-tenant-id")).toBe("tenant-route");
    expect(capture.request?.headers.get("x-gemini-call-control-id")).toBe("call-control-route");
    expect(capture.request?.headers.get("x-gemini-call-session-id")).toBe("call-session-route");
    expect(capture.request?.headers.get("x-gemini-edge-session-id")).toBe("edge-session-route");
    expect(capture.request?.headers.get("x-gemini-credential-id")).toBe("credential-route");
    expect(capture.request?.headers.get("x-gemini-capability-not-after")).toBe(String(NOW + 60_000));
  });

  it("fails closed for missing, expired or tampered capabilities", async () => {
    const missing = await routeAuthenticatedGeminiControlV1(
      new Request("https://worker/internal/control"),
      fakeEnv({}),
      NOW,
    );
    expect(missing.status).toBe(401);

    const expiredToken = await issueGeminiControlCapabilityV1(claims({ notAfterEpochMs: NOW }), SECRET);
    const expired = await routeAuthenticatedGeminiControlV1(
      new Request("https://worker/internal/control", { headers: { Authorization: `Bearer ${expiredToken}` } }),
      fakeEnv({}),
      NOW,
    );
    expect(expired.status).toBe(403);

    const validToken = await issueGeminiControlCapabilityV1(claims(), SECRET);
    const tamperedToken = `${validToken.slice(0, -1)}${validToken.endsWith("a") ? "b" : "a"}`;
    const tampered = await routeAuthenticatedGeminiControlV1(
      new Request("https://worker/internal/control", { headers: { Authorization: `Bearer ${tamperedToken}` } }),
      fakeEnv({}),
      NOW,
    );
    expect(tampered.status).toBe(403);
  });

  it("rejects legacy public identity query parameters", async () => {
    const token = await issueGeminiControlCapabilityV1(claims(), SECRET);
    const response = await routeAuthenticatedGeminiControlV1(
      new Request("https://worker/internal/control?credential_id=legacy", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fakeEnv({}),
      NOW,
    );
    expect(response.status).toBe(400);
  });
});
