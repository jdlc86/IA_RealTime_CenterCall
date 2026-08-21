import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("control-plane Workers runtime", () => {
  it("boots the configured entrypoint and exposes binding health", async () => {
    const response = await exports.default.fetch("https://control-plane.test/health");
    const body = await response.json<{
      ok: boolean;
      service: string;
      runtime_config: {
        tenant_config_binding: boolean;
        call_sessions_binding: boolean;
      };
      worker_version: {
        id: string | null;
        tag: string | null;
        timestamp: string | null;
      };
    }>();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.service).toBe("IA_RealTime_CenterCall");
    expect(body.runtime_config).toMatchObject({
      tenant_config_binding: true,
      call_sessions_binding: true,
    });
    expect(body.worker_version.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.worker_version.tag).toBe("string");
    expect(body.worker_version.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("runs KV operations through the configured runtime binding", async () => {
    const key = "runtime-smoke/missing-and-present";

    expect(await env.TENANT_CONFIG.get(key)).toBeNull();
    await env.TENANT_CONFIG.put(key, "ok");
    expect(await env.TENANT_CONFIG.get(key)).toBe("ok");
  });

  it("instantiates the active Durable Object chain and dispatches status", async () => {
    const id = env.CALL_SESSIONS.idFromName("runtime-smoke-call-session");
    const response = await env.CALL_SESSIONS.get(id).fetch("https://call-session.internal/status");
    const body = await response.json<{
      ok: boolean;
      call_id: string | null;
      tenant_id: string | null;
      state: string;
      websocket_connected: boolean;
      sideband?: string;
    }>();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      call_id: null,
      tenant_id: null,
      state: "active",
      websocket_connected: false,
    });
  });

  it("preserves the fail-closed HTTP boundary for unknown routes", async () => {
    const response = await exports.default.fetch("https://control-plane.test/not-a-route");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "not_found" });
  });
});
