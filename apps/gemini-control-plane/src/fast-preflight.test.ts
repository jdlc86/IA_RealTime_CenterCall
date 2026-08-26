import { describe, expect, it, vi } from "vitest";
import { routeFastGeminiPreflight, type FastGeminiPreflightEnv } from "./fast-preflight";

const SECRET = "0123456789abcdef0123456789abcdef";
const TELNYX_PUBLIC_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

function env(overrides: Partial<FastGeminiPreflightEnv> = {}): FastGeminiPreflightEnv {
  return {
    TELNYX_API_KEY: "KEY_test",
    TELNYX_PUBLIC_KEY,
    GEMINI_ADMISSION_IDENTITY_SECRET: SECRET,
    GEMINI_MEDIA_CREDENTIAL_HMAC_SECRET: SECRET,
    GEMINI_MEDIA_CONTROL_PLANE_TOKEN: SECRET,
    GEMINI_FAST_CANARY_EDGE_URL: "wss://fast.example.test/telnyx/gemini",
    GEMINI_FAST_CANARY_CALLED_NUMBER: "+34600000000",
    GEMINI_FAST_CANARY_TENANT_ID: "restaurante-centro",
    GEMINI_FAST_CANARY_SYSTEM_INSTRUCTION: "Responde brevemente en español.",
    GEMINI_FAST_PREFLIGHT_TOKEN: SECRET,
    ...overrides,
  };
}

function request(token = SECRET): Request {
  return new Request("https://worker.example.test/internal/preflight", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("fast runtime preflight", () => {
  it("rejects unauthorized requests before any external effect", async () => {
    const fetcher = vi.fn();
    const response = await routeFastGeminiPreflight(request("wrong-token-that-is-long-enough-000000"), env(), { fetcher });
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when required runtime configuration is missing", async () => {
    const fetcher = vi.fn();
    const response = await routeFastGeminiPreflight(request(), env({ TELNYX_API_KEY: "" }), { fetcher });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, status: "CONFIG_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("proves bootstrap control auth and HMAC websocket upgrade without sending Telnyx start", async () => {
    const accept = vi.fn();
    const close = vi.fn();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/internal/bootstrap")) {
        const body = JSON.parse(String(init?.body)) as { credentialId: string };
        return Response.json({ ok: true, credentialId: body.credentialId }, { status: 201 });
      }
      if (url === "https://fast.example.test/telnyx/gemini") {
        return { webSocket: { accept, close } } as unknown as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const response = await routeFastGeminiPreflight(request(), env(), {
      fetcher,
      now: () => 1_800_000_000_000,
      randomUUID: (() => {
        const values = ["credential-id", "call-id"];
        return () => values.shift() ?? "extra-id";
      })(),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body).toEqual({
      ok: true,
      status: "READY",
      checks: {
        telnyxApiKey: "PRESENT",
        telnyxPublicKey: "PRESENT_VALID",
        admissionIdentitySecret: "PRESENT",
        mediaCredentialHmac: "VERIFIED",
        mediaControlToken: "VERIFIED",
        canaryEdge: "VERIFIED",
        canaryCalledNumber: "PRESENT",
        canaryTenant: "PRESENT",
        systemInstruction: "PRESENT",
        tools: "EMPTY",
        bootstrap: "VERIFIED",
        websocketUpgrade: "VERIFIED",
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://fast.example.test/internal/bootstrap");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(calls[1].url).toBe("https://fast.example.test/telnyx/gemini");
    expect(new Headers(calls[1].init?.headers).get("upgrade")).toBe("websocket");
    expect(new Headers(calls[1].init?.headers).get("x-telnyx-streaming-auth-token")).toMatch(/^v1\./);
    expect(accept).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(1000, "preflight");
    expect(JSON.stringify(body)).not.toContain("restaurante-centro");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});
