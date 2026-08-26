import { describe, expect, it, vi } from "vitest";
import { routeFastDiagnosticIngest } from "./fast-diagnostics-ingest";

const CONTROL_TOKEN = "0123456789abcdef0123456789abcdef";
const SERVICE_ROLE = "service-role-secret-for-tests-only";

function event(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "v3:test:media_edge:epoch:1",
    occurred_at: "2026-08-26T20:00:00.000Z",
    call_id: "v3:test",
    call_control_id: "v3:test",
    tenant_id: "restaurante-centro",
    plane: "media_edge",
    component: "gemini-media-edge-fast",
    stage: "FAST_SESSION_CLOSED",
    severity: "info",
    error_code: null,
    sequence: 1,
    causal_parent_event_id: null,
    response_id: null,
    item_id: null,
    stream_id: null,
    elapsed_ms: 1200,
    duration_ms: null,
    audio_duration_ms: null,
    chunk_count: null,
    sample_count: null,
    details: { reason: "TELNYX_STOP" },
    ...overrides,
  };
}

function request(body: unknown, token = CONTROL_TOKEN) {
  return new Request("https://worker.example/internal/diagnostics-ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("fast diagnostic ingest", () => {
  it("rejects unauthenticated diagnostic batches before any persistence", async () => {
    const fetcher = vi.fn();
    const response = await routeFastDiagnosticIngest(request({ events: [event()] }, "wrong-token"), {
      GEMINI_MEDIA_CONTROL_PLANE_TOKEN: CONTROL_TOKEN,
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
    }, { fetcher });
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase persistence is not configured", async () => {
    const fetcher = vi.fn();
    const response = await routeFastDiagnosticIngest(request({ events: [event()] }), {
      GEMINI_MEDIA_CONTROL_PLANE_TOKEN: CONTROL_TOKEN,
    }, { fetcher });
    expect(response.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("persists one bounded call batch with service-role credentials only after ingest", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${SERVICE_ROLE}`);
      expect(headers.get("apikey")).toBe(SERVICE_ROLE);
      expect(headers.get("prefer")).toContain("resolution=merge-duplicates");
      const rows = JSON.parse(String(init?.body));
      expect(rows).toHaveLength(1);
      expect(rows[0].event).toBe("fast_cross_plane_diagnostic");
      expect(rows[0].persisted_at).toBe("2026-08-26T20:01:00.000Z");
      expect(rows[0].details).toEqual({ reason: "TELNYX_STOP" });
      return new Response(null, { status: 201 });
    });
    const response = await routeFastDiagnosticIngest(request({ events: [event()] }), {
      GEMINI_MEDIA_CONTROL_PLANE_TOKEN: CONTROL_TOKEN,
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
    }, {
      fetcher,
      now: () => new Date("2026-08-26T20:01:00.000Z"),
    });
    expect(response.status).toBe(201);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects batches that mix calls", async () => {
    const fetcher = vi.fn();
    const response = await routeFastDiagnosticIngest(request({
      events: [event(), event({ event_id: "v3:other:media_edge:epoch:1", call_id: "v3:other", call_control_id: "v3:other" })],
    }), {
      GEMINI_MEDIA_CONTROL_PLANE_TOKEN: CONTROL_TOKEN,
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
    }, { fetcher });
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
